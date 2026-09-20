// Bun 宿主进程：库内嵌 omp SDK 的多会话容器（仿 etower-agent 的 session 池形式）。
//
// 进程模型：
// - 进程级底座只装配一次（authStorage / modelRegistry / settings），逐会话注入（bootstrap.ts + profile.ts）
// - 每个会话 = 进程内一个 AgentSession + 私有 AgentRegistry（多顶层并发必传）
// - 会话落在独立 profile `omp-desktop` 下（~/.omp/profiles/omp-desktop/agent），
//   与用户 CLI 的 ~/.omp/agent 隔离；profile 沿用旧 RPC 版的认证（agent.db）
// - UI 壳通过 WebSocket 连入：命令（create/load/prompt/list/get_messages/get_limits 等）+ 窄事件流
// - stdout 首行打印 `READY ws://127.0.0.1:<port>`，由 Tauri 壳读取后转告前端
//
// 模块分工：bootstrap.ts（SDK 加载顺序闸门）/ state.ts（共享可变状态 H）/ profile.ts（profile·env·项目清单）/
// models.ts（模型目录与设置快照）/ assets.ts（skills·mcp·agents 磁盘资产）/ stats.ts（使用统计）/
// translate.ts（omp 事件 → 前端窄事件）。本文件只保留 WebSocket 服务与会话生命周期。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  SessionManager,
  createAgentSession,
  AgentRegistry,
  Tokenizer,
  getProviderDefinition,
  initialProfile,
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  isUserQueuedMessage,
  isHiddenUserCompanion,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import {
  H,
  sessions,
  defaultCwd,
  enabledDefaults,
  loginPendingPrompts,
  type PoolEntry,
  type TranscriptItem,
  type DesktopEnv,
} from "./state.ts";
import {
  applyProfile,
  refreshAvailableProfiles,
  saveDesktopProjects,
  mergeHistoryProjects,
  applySleepPrevention,
  applyDesktopEnv,
} from "./profile.ts";
import { rebuildScopedModels, modelsPayload, settingsSnapshot, modelCatalog, modelRolesPayload } from "./models.ts";
import {
  listAgentAssets,
  probeMcpServerHealth,
  mcpHealthCache,
  nearestProjectOmpDir,
  assetOmpDir,
  mcpCandidates,
  resolveAssetFile,
  type AssetKind,
} from "./assets.ts";
import { collectUsageStats } from "./stats.ts";
import { translateEvent, translateSubagentEvent, entriesToTranscript } from "./translate.ts";
import { fetchSessionLimits, fetchProviderAccountsLimits, refreshAllLimits, listAllProviders } from "./limits/index.ts";

// ---------- 启动序言：激活持久化 profile，装配进程级底座 ----------
H.currentProfile = initialProfile;
await refreshAvailableProfiles();
await applyProfile(H.currentProfile);

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

// MCP 工具(mcp__ 前缀)schema token 单独估算;breakdown 的 systemToolsTokens 含全部工具,
// 前端展示时减去即得纯内置系统工具。roster 身份不变就不重算。
// 注:发布的 pi-coding-agent npm 包不含 modes/utils/context-usage,这里用
// Tokenizer 直接数 wire schema JSON(approximate 模式),不引 SDK 内部模块。
function estimateMcpToolsTokens(entry: PoolEntry): number {
  const tools = entry.session.state?.tools;
  if (!Array.isArray(tools)) return 0;
  const cached = mcpTokensCache.get(tools);
  if (cached !== undefined) return cached;
  const model = entry.session.model;
  if (!model) return 0;
  const fragments: string[] = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !tool.name.startsWith("mcp__")) continue;
    fragments.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  if (fragments.length === 0) return 0;
  const tokens = new Tokenizer(model).countTokens(fragments);
  mcpTokensCache.set(tools, tokens);
  return tokens;
}

function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const result = await createAgentSession({
    cwd,
    authStorage: H.authStorage,
    modelRegistry: H.modelRegistry,
    settings: H.settings,
    model: initialModel ?? H.modelOverride,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager,
    disableExtensionDiscovery: true,
    enableMCP: false,
    hasUI: true, // 审批 gate 的 fail-cold 判定走 runner.hasUI()：不开则非 yolo 模式下所有需审批工具直接报错
  });
  const { session } = result;
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result, // setToolUIContext 等宿主注入点
    unsubscribe: () => {},
    providerSessionId: sessionManager.getSessionId?.() ?? sessionId, // 请求侧 getApiKey 的粘性键
    transcript,
    assistantDraft: "", // 当前 turn 的流式文本累积，turn_end 时定稿
    thinkingDraft: "",
    thinkingStartedAt: null,
    path: session.sessionFile,
    cwd,
    isGit: isGitWorktree(cwd),
    queuedTexts: [], // 排队消息文本快照（turn_end 竞态兜底）
    consumedTexts: [],
  };
  return { sessionId, entry, eventBus: result.eventBus };
}

// ---------- WebSocket 服务 ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // 动态端口：多 workspace 并行开同名应用时固定端口会撞
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      process.stderr.write(`[host] WS 客户端接入（前端加载与连接全链路 OK）\n`);
      ws.send(
        JSON.stringify({
          type: "ready",
          approvalMode: H.settings.get("tools.approvalMode"),
          models: modelsPayload(),
          settings: settingsSnapshot(),
        }),
      );
    },
    async message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "非法 JSON" }));
        return;
      }
      try {
        switch (msg.type) {
          case "create_session":
            await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking);
            break;
          case "load_session":
            await handleLoadSession(ws, msg.path);
            break;
          case "list_sessions":
            await handleListSessions(ws);
            break;
          case "remove_project": {
            // 移出项目列表（会话仍保留在历史中，「最近」视图照常见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            if (!H.desktopProjects.removedProjects.includes(cwd)) H.desktopProjects.removedProjects.push(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "delete_session": {
            // 彻底删除会话（物理文件 + 对应 artifacts 目录 + 内存会话池与置顶记录）
            const p = String(msg.path ?? "").trim();
            if (!p) throw new Error("缺少 path");
            for (const [key, entry] of sessions.entries()) {
              if (entry.path === p) {
                try { entry.unsubscribe(); } catch {}
                sessions.delete(key);
              }
            }
            const pi = H.desktopProjects.pinnedSessions.indexOf(p);
            if (pi >= 0) {
              H.desktopProjects.pinnedSessions.splice(pi, 1);
              await saveDesktopProjects();
            }
            try {
              await fs.promises.unlink(p);
            } catch (err: any) {
              if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话文件失败: ${err}\n`);
            }
            if (p.endsWith(".jsonl")) {
              const artifactsDir = p.slice(0, -6);
              try {
                await fs.promises.rm(artifactsDir, { recursive: true, force: true });
              } catch (err: any) {
                if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话产物目录失败: ${err}\n`);
              }
            }
            await handleListSessions(ws);
            break;
          }
          case "set_project_expanded": {
            // 项目展开态持久化：记录在 omp-desktop.json expandedProjects，未记录的默认收起
            const cwd = String(msg.cwd ?? "").trim();
            const on = !!msg.expanded;
            if (!cwd) throw new Error("缺少 cwd");
            const i = H.desktopProjects.expandedProjects.indexOf(cwd);
            if (on && i < 0) H.desktopProjects.expandedProjects.push(cwd);
            if (!on && i >= 0) H.desktopProjects.expandedProjects.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "set_session_pinned": {
            // 置顶会话持久化：记录在 omp-desktop.json pinnedSessions，重启保持
            const p = String(msg.path ?? "").trim();
            const on = !!msg.pinned;
            if (!p) throw new Error("缺少 path");
            const i = H.desktopProjects.pinnedSessions.indexOf(p);
            if (on && i < 0) H.desktopProjects.pinnedSessions.push(p);
            if (!on && i >= 0) H.desktopProjects.pinnedSessions.splice(i, 1);
            await saveDesktopProjects();
            break;
          }
          case "add_project": {
            // 手动添加：命中已移除列表则移回所有项目列表，否则作为新项目并入（置顶，立即可见）
            const cwd = String(msg.cwd ?? "").trim();
            if (!cwd) throw new Error("缺少 cwd");
            const ri = H.desktopProjects.removedProjects.indexOf(cwd);
            if (ri >= 0) H.desktopProjects.removedProjects.splice(ri, 1);
            if (!H.desktopProjects.allProjects.includes(cwd)) H.desktopProjects.allProjects.unshift(cwd);
            await saveDesktopProjects();
            await handleListSessions(ws);
            break;
          }
          case "reorder_projects": {
            // 拖拽排序：以 UI 传来的完整顺序为准；未涵盖的既有项（并发变更兜底）保持原序追加尾部
            const order = Array.isArray(msg.order) ? msg.order.filter((x: unknown) => typeof x === "string") : [];
            if (order.length === 0) throw new Error("缺少 order");
            const set = new Set(order);
            const rest = H.desktopProjects.allProjects.filter((c) => !set.has(c));
            H.desktopProjects.allProjects = [...order, ...rest];
            await saveDesktopProjects();
            break;
          }
          case "prompt":
            await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""), msg.files);
            break;
          case "peek_queued":
            handlePeekQueued(ws, msg.sessionId);
            break;
          case "drop_queued":
            handleDropQueued(
              ws,
              msg.sessionId,
              msg.queue === "steering" ? "steering" : "followUp",
              msg.index === undefined ? undefined : Number(msg.index),
            );
            break;
          case "send_now":
            await handleSendNow(ws, msg.sessionId, Number(msg.index));
            break;
          case "requeue":
            handleRequeue(ws, msg.sessionId, Number(msg.index));
            break;
          case "get_messages":
            handleGetMessages(ws, msg.sessionId);
            break;
          case "get_file_diff": {
            // 单文件详细 diff：tracked 走 git diff HEAD，untracked/仓库外文件用 --no-index 生成纯新增。
            // cwd 外的文件（如 ~/.omp 全局配置）不拒绝：找它自己所在的 git 仓库；不在任何仓库就整文件当新增。
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const filePath = String(msg.path ?? "");
            if (!filePath) throw new Error("缺少 path");
            const abs = path.resolve(cwd, filePath);
            let repoCwd = cwd;
            if (!abs.startsWith(path.resolve(cwd) + path.sep)) {
              const top = Bun.spawnSync(["git", "-C", path.dirname(abs), "rev-parse", "--show-toplevel"], {
                stdout: "pipe",
                stderr: "ignore",
              });
              const topLevel = top.exitCode === 0 ? top.stdout.toString().trim() : "";
              if (topLevel && abs.startsWith(topLevel + path.sep)) repoCwd = topLevel;
            }
            const rel = path.relative(path.resolve(repoCwd), abs);
            const tracked =
              repoCwd === cwd
                ? Bun.spawnSync(["git", "-C", cwd, "ls-files", "--error-unmatch", "--", filePath], {
                    stdout: "ignore",
                    stderr: "ignore",
                  })
                : Bun.spawnSync(["git", "-C", repoCwd, "ls-files", "--error-unmatch", "--", rel], {
                    stdout: "ignore",
                    stderr: "ignore",
                  });
            const args = tracked.exitCode === 0
              ? ["diff", "HEAD", "--", rel]
              : ["diff", "--no-index", "--", "/dev/null", abs];
            const p = Bun.spawnSync(["git", "-C", repoCwd, ...args], { stdout: "pipe", stderr: "pipe" });
            // --no-index 有差异时 exitCode=1 属正常
            if (p.exitCode > 1) throw new Error(`git diff 失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            ws.send(
              JSON.stringify({
                type: "file_diff",
                cwd,
                path: filePath,
                diff: p.stdout.toString().slice(0, 500_000),
              }),
            );
            break;
          }
          case "read_file": {
            // 文件页全文件内容（读取行点击 / 文件树点击详情共用）；限 2MB 文本文件
            const p = String(msg.path ?? "");
            if (!p) throw new Error("缺少 path");
            const stat = fs.statSync(p, { throwIfNoEntry: false });
            if (!stat?.isFile()) throw new Error(`不是文件: ${p}`);
            if (stat.size > 2_000_000) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: `文件过大（${(stat.size / 1e6).toFixed(1)} MB），仅支持 2MB 内的文本文件` }));
              break;
            }
            const buf = await fs.promises.readFile(p);
            const head = buf.subarray(0, 8000);
            if (head.includes(0)) {
              ws.send(JSON.stringify({ type: "file_content", path: p, error: "二进制文件，不支持文本预览" }));
              break;
            }
            ws.send(JSON.stringify({ type: "file_content", path: p, text: buf.toString("utf8") }));
            break;
          }
          case "list_dir": {
            // 文件树单层列表：目录优先、字母序；隐藏 .git/.DS_Store
            const dir = String(msg.path ?? "");
            if (!dir) throw new Error("缺少 path");
            const stat = fs.statSync(dir, { throwIfNoEntry: false });
            if (!stat?.isDirectory()) throw new Error(`不是目录: ${dir}`);
            const entries: { name: string; dir: boolean }[] = [];
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name === ".git" || e.name === ".DS_Store") continue;
              entries.push({ name: e.name, dir: e.isDirectory() });
            }
            entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
            ws.send(JSON.stringify({ type: "dir_list", path: dir, entries }));
            break;
          }
          case "get_todos": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            ws.send(JSON.stringify({ type: "todos", sessionId: msg.sessionId, phases: entry.session.getTodoPhases() }));
            break;
          }
          case "get_context_detail": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const b = entry.session.getContextBreakdown();
            const st = entry.session.getSessionStats();
            ws.send(
              JSON.stringify({
                type: "context_detail",
                sessionId: msg.sessionId,
                breakdown: b ? { ...b, mcpToolsTokens: estimateMcpToolsTokens(entry) } : null,
                stats: {
                  tokens: st.tokens,
                  userMessages: st.userMessages,
                  assistantMessages: st.assistantMessages,
                  toolCalls: st.toolCalls,
                  totalMessages: st.totalMessages,
                  premiumRequests: st.premiumRequests,
                  cost: st.cost,
                },
              }),
            );
            break;
          }
          case "get_limits": {
            // 会话当前供应商的套餐限额(token-monitor 移植逻辑,host/limits/)
            // 无会话时(UI 输入框空环 hover)允许按 msg.provider 查询,只显示配额段
            const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
            const ompProvider = entry?.session.model?.provider || String(msg.provider ?? "");
            if (!ompProvider) throw new Error("会话尚未选择模型");
            let baseUrl = "";
            try {
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            // 多账号对齐:与会话请求同参(providerSessionId 粘性 + modelId)解析凭证,
            // 明细卡配额即本会话实际命中的账号;key 反查凭证 id 后以 #id 为缓存键
            // (与模型页 accounts/后台预载共用同一缓存行),身份标签一并回填
            let keyOverride: string | null | undefined;
            let cacheTag: string | undefined;
            let accountLabel = "";
            if (entry) {
              const model = entry.session.model;
              keyOverride =
                (await H.authStorage.getApiKey(ompProvider, entry.providerSessionId, {
                  baseUrl,
                  modelId: model?.id,
                })) ?? null;
              const hit = (H.authStorage.listStoredCredentials?.(ompProvider) ?? []).find((c: any) => {
                const cred = c.credential;
                return cred?.type === "api_key" ? cred.key === keyOverride : cred?.access === keyOverride;
              });
              if (hit) cacheTag = `#${hit.id}`;
              const cred: any = hit?.credential;
              accountLabel = cred?.email ?? cred?.accountId ?? cred?.orgName ?? "";
            }
            const { vendor, label, row } = await fetchSessionLimits(H.authStorage, ompProvider, baseUrl, keyOverride, cacheTag);
            ws.send(
              JSON.stringify({
                type: "limits_result",
                sessionId: msg.sessionId,
                label: accountLabel ? `${label} · ${accountLabel}` : label,
                unsupported: vendor === null,
                status: row?.status ?? "unavailable",
                planLabel: row?.planLabel ?? "",
                accountLabel,
                balance: row?.balance ?? null,
                windows: row?.windows ?? [],
                updatedAt: row?.updatedAt ?? null,
              }),
            );
            break;
          }
          case "get_provider_limits": {
            // 模型管理页按供应商读配额(多账号逐凭证,命中 limits 60s 缓存)
            const ompProvider = String(msg.provider ?? "");
            if (!ompProvider) throw new Error("缺少 provider");
            let baseUrl = "";
            try {
              baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
            } catch {
              baseUrl = "";
            }
            const { vendor, label, accounts } = await fetchProviderAccountsLimits(H.authStorage, ompProvider, baseUrl);
            const first = accounts[0]?.row;
            ws.send(
              JSON.stringify({
                type: "provider_limits_result",
                provider: ompProvider,
                label,
                unsupported: vendor === null,
                // 顶层字段取首个账号(单账号消费方兼容);多账号时前端读 accounts 逐段渲染
                status: first?.status ?? "unavailable",
                planLabel: first?.planLabel ?? "",
                accountLabel: accounts[0]?.label || first?.accountLabel || "",
                balance: first?.balance ?? null,
                windows: first?.windows ?? [],
                updatedAt: first?.updatedAt ?? null,
                accounts: accounts.map((a) => ({
                  id: a.id,
                  label: a.label || a.row.accountLabel || "",
                  status: a.row.status ?? "unavailable",
                  planLabel: a.row.planLabel ?? "",
                  accountLabel: a.row.accountLabel ?? "",
                  balance: a.row.balance ?? null,
                  windows: a.row.windows ?? [],
                  updatedAt: a.row.updatedAt ?? null,
                })),
              }),
            );
            break;
          }
          case "get_git_diff": {
            // 当前会话 project 的改动文件清单（树/平铺展示用）
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const p = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) throw new Error(`git status 失败: ${p.stderr.toString().trim().slice(0, 200) || "非 git 仓库"}`);
            const files = p.stdout
              .toString()
              .split("\n")
              .filter((l) => l.trim())
              .map((line) => {
                let path = line.slice(3);
                const arrow = path.indexOf(" -> "); // rename：R  old -> new
                if (arrow >= 0) path = path.slice(arrow + 4);
                return { code: line.slice(0, 2).trim() || "?", path };
              });
            ws.send(JSON.stringify({ type: "git_status", cwd, files }));
            break;
          }
          case "get_git_branches": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const isGit = isGitWorktree(cwd);
            if (!isGit) {
              ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: false, current: null, branches: [] }));
              break;
            }
            const currP = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
            let current = currP.stdout.toString().trim();
            if (!current) {
              const headP = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
              current = headP.stdout.toString().trim() || "HEAD";
            }
            const bP = Bun.spawnSync(["git", "-C", cwd, "branch", "--format=%(refname:short)"], { stdout: "pipe", stderr: "ignore" });
            const branches = bP.stdout.toString().split("\n").map((b) => b.trim()).filter(Boolean);
            ws.send(JSON.stringify({ type: "git_branches", cwd, isGit: true, current, branches }));
            break;
          }
          case "switch_git_branch": {
            const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : defaultCwd;
            const targetBranch = String(msg.branch ?? "").trim();
            if (!targetBranch) throw new Error("缺少 branch");
            const p = Bun.spawnSync(["git", "-C", cwd, "checkout", targetBranch], { stdout: "pipe", stderr: "pipe" });
            if (p.exitCode !== 0) {
              throw new Error(`切换分支失败: ${p.stderr.toString().trim().slice(0, 200)}`);
            }
            ws.send(JSON.stringify({ type: "git_branch_switched", cwd, branch: targetBranch }));
            break;
          }
          case "set_approval_mode": {
            const mode = msg.mode;
            if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
              throw new Error(`非法审批模式: ${mode}`);
            }
            // execute-time 解析：无需重建会话，下一个工具调用即生效（对全部会话生效——settings 全进程共享）
            H.settings.override("tools.approvalMode", mode);
            ws.send(JSON.stringify({ type: "approval_mode", mode }));
            break;
          }
          case "approval_response": {
            const pending = pendingApprovals.get(msg.requestId);
            if (!pending) throw new Error(`审批请求不存在或已结束: ${msg.requestId}`);
            pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
            ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
            break;
          }
          case "set_model": {
            const entry = sessions.get(msg.sessionId);
            process.stderr.write(`[host] set_model: ${msg.model} entry=${!!entry}\n`);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            const target = H.scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
            if (!target) throw new Error(`未知模型: ${msg.model}`);
            await entry.session.setModel(target); // persist 默认 false，仅本会话生效
            // enabledModels 条目带的 ":thinking" 默认级别与 CLI 行为一致地应用
            const defaultLevel = enabledDefaults.get(msg.model);
            if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
            const model = `${entry.session.model.provider}/${entry.session.model.id}`;
            // 模型切换后思考级别可能被能力钳制，一并回传生效值
            ws.send(
              JSON.stringify({
                type: "session_model",
                sessionId: msg.sessionId,
                model,
                thinking: entry.session.thinkingLevel ?? "auto",
              }),
            );
            break;
          }
          case "set_thinking": {
            const entry = sessions.get(msg.sessionId);
            if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
            entry.session.setThinkingLevel(msg.level);
            // getter 返回按模型能力钳制后的生效值（如 medium→low），如实回传
            ws.send(
              JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.thinkingLevel ?? "auto" }),
            );
            break;
          }
          case "ui_error": {
            // 前端未捕获错误上报（WKWebView 无 console，dev 终端是唯一出口）
            process.stderr.write(`[ui] ${msg.message}\n`);
            break;
          }
          case "get_settings":
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            break;
          case "reload_settings": {
            // 本地 config 文件可能被手工修改：从磁盘重载（仅模型设置），并推送新模型列表
            try {
              await H.settings.reloadFromDisk();
              rebuildScopedModels();
              ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            } catch (err) {
              process.stderr.write(`[host] reload_settings 失败: ${err}\n`);
            }
            break;
          }
          case "set_setting": {
            const key = String(msg.key ?? "");
            const value = msg.value;
            if (key === "hideThinkingBlock") {
              try {
                (H.settings as any).set("hideThinkingBlock", !!value);
              } catch (err) {
                process.stderr.write(`[host] hideThinkingBlock 未写入 schema: ${err}\n`);
              }
            } else if (key === "power.sleepPrevention") {
              const level = value === "system" || value === "display" || value === "idle" || value === "off" ? value : "off";
              H.settings.set("power.sleepPrevention", level);
              applySleepPrevention(level);
            } else if (key === "computer.enabled") H.settings.set("computer.enabled", !!value);
            else if (key === "ask.timeout") {
              const secs = Number(value);
              if (!Number.isFinite(secs) || secs < 0) throw new Error("ask.timeout 必须是非负秒数");
              H.settings.set("ask.timeout", secs);
            } else if (key === "memory.backend") {
              const backend =
                value === "off" || value === "local" || value === "hindsight" || value === "mnemopi" || value === "sharpshooter"
                  ? value
                  : "off";
              H.settings.set("memory.backend", backend);
            } else throw new Error(`不支持的设置项: ${key}`);
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            break;
          }
          case "set_desktop_env": {
            const next: DesktopEnv = {
              httpProxy: String(msg.httpProxy ?? "").trim(),
              noProxy: String(msg.noProxy ?? "").trim(),
              caCerts: String(msg.caCerts ?? "").trim(),
            };
            await writeFile(H.desktopEnvPath, JSON.stringify(next, null, 2));
            H.desktopEnv = next;
            H.desktopEnvFilePresent = true;
            applyDesktopEnv(next);
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot(), restartHint: true }));
            break;
          }
          case "get_models_catalog":
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          case "get_all_providers":
            ws.send(
              JSON.stringify({
                type: "all_providers",
                providers: listAllProviders().map((p) => ({
                  ...p,
                  // 登录能力:OAuth/login 流存在即可(API key 对所有供应商可用)
                  login: !!getProviderDefinition(p.id)?.login,
                })),
              }),
            );
            break;
          case "provider_login": {
            // OMP 登录流程(AuthStorage.login):浏览器授权 + 需要粘贴码时经 UI 弹窗中转
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            if (H.loginInFlight) throw new Error("已有登录流程进行中，请完成或稍后再试");
            H.loginInFlight = true;
            H.loginAbort = new AbortController();
            const reqId = msg.reqId ?? null;
            const wsRef = ws;
            const reply = (obj: Record<string, unknown>) => {
              try {
                wsRef.send(JSON.stringify({ reqId, ...obj }));
              } catch {}
            };
            reply({ type: "login_progress", provider, message: "正在启动登录…" });
            let promptSeq = 0;
            try {
              const identity = await H.authStorage.login(provider, {
                signal: H.loginAbort.signal,
                onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
                  if (H.loginAbort?.signal.aborted) return;
                  const url = info.launchUrl ?? info.url;
                  if (url) {
                    try {
                      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
                    } catch {}
                  }
                  reply({
                    type: "login_progress",
                    provider,
                    message: info.instructions || "已在浏览器打开登录页面，请完成授权…",
                    url: url ?? "",
                  });
                },
                onProgress: (message: string) => reply({ type: "login_progress", provider, message: String(message) }),
                onPrompt: (prompt: { message?: string; secret?: boolean }) =>
                  new Promise<string>((resolve, reject) => {
                    const id = ++promptSeq;
                    loginPendingPrompts.set(id, resolve);
                    H.loginAbort?.signal.addEventListener(
                      "abort",
                      () => {
                        loginPendingPrompts.delete(id);
                        reject(new Error("aborted"));
                      },
                      { once: true },
                    );
                    reply({ type: "login_prompt", provider, id, message: String(prompt.message ?? ""), secret: !!prompt.secret });
                  }),
              });
              // 登录成功:重新拉取模型目录(新凭证使供应商可用),并推送最新列表
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              reply({ type: "models", models: modelsPayload() });
              reply({ type: "models_catalog", models: modelCatalog() });
              reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
            } catch (err) {
              const aborted = H.loginAbort?.signal.aborted;
              reply({
                type: "login_done",
                provider,
                ok: false,
                cancelled: !!aborted,
                message: aborted ? "登录已取消" : String((err as any)?.message ?? err),
              });
            } finally {
              H.loginInFlight = false;
              H.loginAbort = null;
            }
            break;
          }
          case "provider_logout": {
            // 登出供应商：删除存储凭证（本地毫秒级）后立即本地过滤推送目录，UI 瞬时移除；
            // 完整的 modelRegistry.refresh()（逐供应商网络发现，秒级）随后收敛再推一版(幂等)。
            // models.yml 手写 apiKey 的优先级高于存储凭证，该类供应商 UI 不提供登出入口
            const provider = String(msg.provider ?? "");
            if (!provider) throw new Error("缺少 provider");
            await H.authStorage.remove(provider);
            H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
            rebuildScopedModels();
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            try {
              await H.modelRegistry.refresh();
              H.availableModels = H.modelRegistry.getAvailable();
              rebuildScopedModels();
              ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
              ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            } catch (err) {
              process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
            }
            break;
          }
          case "provider_login_cancel": {
            // 用户显式取消(如关闭了登录页):中断进行中的登录流程
            if (H.loginInFlight && H.loginAbort) H.loginAbort.abort();
            else throw new Error("当前没有进行中的登录流程");
            break;
          }
          case "provider_set_key": {
            // 配置 API key:写入 authStorage(api_key 凭证),随后刷新模型目录
            const provider = String(msg.provider ?? "");
            const key = String(msg.key ?? "").trim();
            if (!provider) throw new Error("缺少 provider");
            if (!key) throw new Error("API key 不能为空");
            H.authStorage.upsertCredential(provider, { type: "api_key", key });
            await H.modelRegistry.refresh();
            H.availableModels = H.modelRegistry.getAvailable();
            rebuildScopedModels();
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            ws.send(JSON.stringify({ type: "provider_key_done", provider, ok: true }));
            break;
          }
          case "login_prompt_reply": {
            const resolve = loginPendingPrompts.get(Number(msg.id));
            if (resolve) {
              loginPendingPrompts.delete(Number(msg.id));
              resolve(String(msg.text ?? ""));
            }
            break;
          }
          case "open_models_config": {
            // 「手动添加供应商」:打开配置层 models.yml(不存在则创建空文件)
            const modelsPath = path.join(H.agentDir, "models.yml");
            try {
              if (!fs.existsSync(modelsPath)) fs.writeFileSync(modelsPath, "# omp 供应商配置,参考文档编辑\n");
              Bun.spawn(["open", modelsPath], { stdout: "ignore", stderr: "ignore" });
            } catch {}
            ws.send(JSON.stringify({ type: "models_config_path", path: modelsPath }));
            break;
          }
          case "open_folder": {
            const raw = String(msg.path ?? "");
            if (raw) {
              try {
                if (!fs.existsSync(raw)) await mkdir(raw, { recursive: true });
                Bun.spawn(["open", raw], { stdout: "ignore", stderr: "ignore" });
              } catch {}
            }
            break;
          }
          case "set_enabled_model": {
            const id = String(msg.id ?? "");
            const on = !!msg.enabled;
            if (!H.availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(`未知模型: ${id}`);
            let entries: string[] = (H.settings.get("enabledModels") ?? []).slice();
            if (entries.length === 0) {
              entries = H.availableModels.map((m) => `${m.provider}/${m.id}`);
            }
            const without = entries.filter((e) => e.split(":")[0] !== id);
            if (on) {
              const prev = entries.find((e) => e.split(":")[0] === id);
              without.push(prev ?? id);
            }
            if (without.length === 0) throw new Error("至少保留一个启用模型");
            H.settings.set("enabledModels", without);
            await H.settings.flush();
            rebuildScopedModels();
            if (H.scopedModels.length === 0) throw new Error("启用列表过滤后没有可用模型");
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            break;
          }
          case "get_model_roles":
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
            break;
          case "set_model_role": {
            // 合法名即可写入：既改已知角色，也从输入框菜单创建自定义角色（覆盖同名旧值）
            const role = String(msg.role ?? "");
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)) throw new Error(`非法角色名: ${role}`);
            // UI 只写精确 "provider/model"（或 null 清除回默认链），别名/后缀交给 settings.json 手写
            const value = msg.value == null || msg.value === "" ? undefined : String(msg.value);
            if (value && !H.availableModels.some((m) => `${m.provider}/${m.id}` === value)) {
              throw new Error(`未知模型: ${value}`);
            }
            H.settings.setModelRole(role, value);
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
            break;
          }
          case "get_usage_stats":
            ws.send(JSON.stringify({ type: "usage_stats", stats: await collectUsageStats() }));
            break;
          case "list_agent_assets": {
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_file_read": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            const content = await readFile(file, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            break;
          }
          case "memory_file_read": {
            const raw = String(msg.path ?? "");
            const file = path.resolve(raw);
            const rel = path.relative(path.resolve(path.join(H.agentDir, "memories")), file);
            if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径不在允许的记忆目录内: ${raw}`);
            // 工作区记忆是目录：返回顶层 .md 清单（按修改时间新→旧）并默认读最新的一个
            let target = file;
            let files: string[] | undefined;
            let rollouts: string[] | undefined;
            if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
              const mtime = (dir: string, n: string) => {
                try {
                  return fs.statSync(path.join(dir, n)).mtimeMs;
                } catch {
                  return 0;
                }
              };
              files = (await readdir(file))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(file, b) - mtime(file, a));
              if (!files.length) throw new Error(`记忆目录内没有 .md 文件: ${raw}`);
              target = path.join(file, files[0]);
              const rollDir = path.join(file, "rollout_summaries");
              rollouts = (await readdir(rollDir).catch(() => [] as string[]))
                .filter((n) => n.endsWith(".md") && !n.startsWith("."))
                .sort((a, b) => mtime(rollDir, b) - mtime(rollDir, a));
            }
            const content = await readFile(target, "utf8");
            ws.send(JSON.stringify({ type: "memory_file", path: file, file: path.basename(target), files, rollouts, content }));
            break;
          }
          case "asset_file_write": {
            const kind = String(msg.kind ?? "agent") as AssetKind;
            const file = resolveAssetFile(kind, msg.path);
            await writeFile(file, String(msg.content ?? ""), "utf8");
            ws.send(JSON.stringify({ type: "asset_file_saved", kind, path: file }));
            break;
          }
          case "asset_file_create": {
            // 按作用域与资产类型落位：agent=agents/<name>.md、skill=skills/<name>/SKILL.md、mcp=该级 mcp.json（幂等，已存在则直接返回内容）
            const kind = String(msg.kind ?? "agent") as AssetKind;
            if (kind === "mcp") {
              const file = mcpCandidates(assetOmpDir(kind, msg.scope, msg.cwd))[0];
              if (fs.existsSync(file)) {
                ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content: await readFile(file, "utf8") }));
                break;
              }
              await mkdir(path.dirname(file), { recursive: true });
              const content = `{\n  "mcpServers": {}\n}\n`;
              await writeFile(file, content, "utf8");
              ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
              break;
            }
            const name = String(msg.name ?? "").trim().toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("名称仅允许小写字母、数字、-、_");
            const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), kind === "agent" ? "agents" : "skills");
            await mkdir(dir, { recursive: true });
            const file = kind === "agent" ? path.join(dir, `${name}.md`) : path.join(dir, name, "SKILL.md");
            if (fs.existsSync(file)) throw new Error(`${kind} 已存在: ${name}`);
            await mkdir(path.dirname(file), { recursive: true });
            const content =
              kind === "agent"
                ? `---\nname: ${name}\ndescription: \ntools: read, grep, glob\n---\n\n`
                : `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
            await writeFile(file, content, "utf8");
            ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_toggle": {
            const name = String(msg.name ?? "").trim();
            const enabled = Boolean(msg.enabled);
            if (!name) throw new Error("缺少技能名称");
            const disabled = new Set<string>(((H.settings.get("disabledExtensions") ?? []) as string[]));
            const ignored = new Set<string>(((H.settings.get("skills.ignoredSkills") ?? []) as string[]));
            const skillExtId = `skill:${name}`;
            if (enabled) {
              disabled.delete(skillExtId);
              ignored.delete(name);
            } else {
              disabled.add(skillExtId);
            }
            H.settings.set("disabledExtensions", Array.from(disabled));
            H.settings.set("skills.ignoredSkills", Array.from(ignored));
            await H.settings.flush();
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "asset_skill_delete": {
            const rawPath = String(msg.path ?? "");
            const file = resolveAssetFile("skill", rawPath);
            if (!fs.existsSync(file)) throw new Error(`技能文件不存在: ${file}`);
            const skillDir = path.dirname(file);
            const parentDir = path.dirname(skillDir);
            // 如果是常规的 <skillName>/SKILL.md，安全删除整个技能目录
            if (path.basename(file).toLowerCase() === "skill.md" && parentDir && parentDir !== skillDir) {
              await rm(skillDir, { recursive: true, force: true });
            } else {
              await rm(file, { force: true });
            }
            ws.send(JSON.stringify({ type: "asset_file_deleted", kind: "skill", path: file }));
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "set_mcp_server_enabled": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const enabled = Boolean(msg.enabled);
            const userPath = path.join(H.agentDir, "mcp.json");
            const projectPath = msg.cwd
              ? (nearestProjectOmpDir(msg.cwd) ? path.join(nearestProjectOmpDir(msg.cwd)!, "mcp.json") : path.join(path.resolve(msg.cwd), ".omp", "mcp.json"))
              : undefined;
            await setMcpServerEnabled({
              userPath,
              projectPath: projectPath ?? userPath,
              sourcePath: msg.sourcePath ? String(msg.sourcePath) : undefined,
              name,
              enabled,
            });
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "test_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            mcpHealthCache.delete(name);
            const probe = await probeMcpServerHealth(msg.server || { name });
            ws.send(JSON.stringify({ type: "mcp_server_tested", name, status: probe.status, error: probe.error }));
            break;
          }
          case "save_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const cfg = msg.config || {};
            const scope = String(msg.scope ?? "profile");
            const targetDir = scope === "global"
              ? path.join(os.homedir(), ".omp", "agent")
              : scope === "profile"
              ? H.agentDir
              : scope.startsWith("project:")
              ? (nearestProjectOmpDir(scope.slice(8)) ?? path.join(path.resolve(scope.slice(8)), ".omp"))
              : H.agentDir;
            await mkdir(targetDir, { recursive: true });
            const targetPath = path.join(targetDir, "mcp.json");
            await updateMCPServer(targetPath, name, cfg);
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "delete_mcp_server": {
            const name = String(msg.name ?? "").trim();
            if (!name) throw new Error("缺少 MCP 服务器名称");
            const src = msg.sourcePath ? String(msg.sourcePath) : undefined;
            const userPath = path.join(H.agentDir, "mcp.json");
            if (src && fs.existsSync(src) && (src.endsWith("mcp.json") || src.endsWith(".mcp.json"))) {
              await removeMCPServer(src, name);
            } else {
              await setMcpServerEnabled({
                userPath,
                projectPath: userPath,
                sourcePath: src,
                name,
                enabled: false,
              });
            }
            mcpHealthCache.delete(name);
            ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            break;
          }
          case "switch_profile": {
            const p = String(msg.profile ?? "").trim();
            if (!p) throw new Error("Profile 名称不能为空");
            await applyProfile(p);
            ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
            ws.send(JSON.stringify({ type: "models", models: modelsPayload() }));
            ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
            await handleListSessions(ws);
            try {
              ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
            } catch {}
            ws.send(JSON.stringify({ type: "profile_switched", profile: H.currentProfile }));
            break;
          }
          default:
            ws.send(JSON.stringify({ type: "error", message: `未知命令: ${msg.type}` }));
        }
      } catch (err) {
        // 单条命令失败不拖垮宿主，错误如实上报前端
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        process.stderr.write(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
  },
});

// ---------- 磁盘资产 ----------
// 取消 1s 指纹轮询自动推送:前端设置页(MCP/技能/子智能体)改用手动「刷新」按钮(list_agent_assets)

// 挂起的审批请求：requestId -> resolve（answer 为 undefined 即拒绝语义）
const pendingApprovals = new Map<string, { resolve: (v: string | undefined) => void }>();

function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify({
        type: "context",
        sessionId,
        tokens: u.tokens,
        window: u.contextWindow,
        percent: u.percent,
      }),
    );
  }
}

function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify({ type: "event", sessionId, ...ui }));
    // todo 工具落盘后推送最新任务清单（TodoTracker 在工具结果后更新）
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify({ type: "todos", sessionId, phases: entry.session.getTodoPhases() }));
    }
    // turn 真正结束后推送上下文占用（此时消息已定稿）；同时校准排队行（steer 已消费）
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      pushContext(ws, sessionId, entry);
      // 收尾竞态兜底：底座在 run 收尾 abort 时，正在 claim 的队列消息会被丢弃且不回队
      // （agent.ts #prepareQueuedMessageBatch 的 dequeue-先移出 + abort-不 restore），表现为
      // 「上次快照里有、现在队列没有、dequeue hook 从未通知消费」。host 重新发送该消息。
      const a = entry.session.agent as any;
      const cur = [...a.peekFollowUpQueue(), ...a.peekSteeringQueue()]
        .filter((m: any) => isUserQueuedMessage(m))
        .map((m: any) => toRestoredQueuedMessage(m).text);
      const curSet = new Set(cur);
      const lost = (entry.queuedTexts ?? []).filter(
        (t) => !curSet.has(t) && !(entry.consumedTexts ?? []).includes(t),
      );
      for (const t of lost) {
        process.stderr.write(`[host] 排队消息被收尾竞态吞掉，重新发送: ${t.slice(0, 60)}\n`);
        entry.consumedTexts.push(t);
        entry.session.prompt(t).catch((err: unknown) => {
          ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
        });
      }
      sendQueued(ws, sessionId, entry);
    }
  });
  // 审批/对话框：非 yolo 模式下审批 gate 通过 ExtensionUIContext.select 挂起等用户选择
  const uiCtx = {
    // ask 等工具的 UI 超时从对话框呈现起算，而不是工具发起时
    timeoutStartsOnPresentation: true,
    select(title: string, options: any[], dialogOptions?: any): Promise<string | undefined> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        // agent 中止/工具取消：AbortSignal 到来即按取消（undefined）结束挂起
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: options.map((o) => (typeof o === "string" ? o : o.label)),
          }),
        );
      });
    },
    confirm(title: string, message: string): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v === "OK");
        };
        pendingApprovals.set(requestId, { resolve: settle });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title: `${title}\n${message}`,
            options: ["OK", "Cancel"],
          }),
        );
      });
    },
    editor(title: string, prefill?: string, dialogOptions?: any): Promise<string | undefined> {
      // ask 的「Other」自定义输入走这里；缺实现会 undefined is not a function 直接挂工具
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const settle = (v: string | undefined) => {
          pendingApprovals.delete(requestId);
          resolve(v);
        };
        pendingApprovals.set(requestId, { resolve: settle });
        dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
        ws.send(
          JSON.stringify({
            type: "approval_request",
            sessionId,
            requestId,
            title,
            options: ["提交", "取消"],
            editable: true,
            prefill: prefill ?? "",
          }),
        );
      });
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // 关键一步（ACP 同款，acp-agent.ts:2631）：runner.hasUI() 判的是 initialize 注入的 uiContext，
  // 只调 setToolUIContext 不够——审批 gate 会 fail-closed「no interactive UI」
  entry.session.extensionRunner?.initialize({}, {}, {}, uiCtx, "rpc");
  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event 帧都在上面
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    ws.send(
      JSON.stringify({
        type: "subagent_lifecycle",
        sessionId,
        subagentId: p.id,
        agent: p.agent,
        description: p.description,
        status: p.status,
      }),
    );
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify({ type: "subagent_event", sessionId, subagentId: id, ...ui }));
  });
  // 消费前通知：即将注入的排队/steer 用户消息推给 UI（气泡转正）；同时记入已消费
  // 清单，供 turn_end 的收尾竞态兜底 diff 排除（hook 触发 ≠ 注入成功，但不重复重发）
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    const texts = [...entry.session.agent.peekFollowUpQueue(), ...entry.session.agent.peekSteeringQueue()]
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      entry.consumedTexts.push(...texts);
      ws.send(JSON.stringify({ type: "steer_consumed", sessionId, texts }));
    }
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubLifecycle();
    unsubEvents();
    detachDequeueHook();
  };
  sessions.set(sessionId, entry);
}

async function handleCreateSession(ws: any, cwd?: string, modelStr?: string, thinkingLevel?: string) {
  const workDir = typeof cwd === "string" && cwd ? cwd : defaultCwd;
  const targetModel = modelStr ? H.scopedModels.find((m) => `${m.provider}/${m.id}` === modelStr) : undefined;
  const { sessionId, entry, eventBus } = await createSessionCore(
    workDir,
    SessionManager.create(workDir),
    [],
    targetModel,
  );
  if (thinkingLevel) {
    try {
      entry.session.setThinkingLevel(thinkingLevel);
    } catch {}
  }
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: workDir,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
      isGit: entry.isGit,
    }),
  );
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始 cwd：getEntries() 不含 session header，用 peekSessionInit 读
  // （open 内部同源；目录不可达时它返回 null，兜底 HOME）
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.thinkingLevel ?? "auto",
      isGit: entry.isGit,
    }),
  );
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // 恢复会话的存量任务清单（TodoTracker 构造时从 transcript 分支同步）
  const restored = entry.session.getTodoPhases();
  if (restored.length > 0) {
    ws.send(JSON.stringify({ type: "todos", sessionId, phases: restored }));
  }
  // 恢复会话的初始上下文占用（system prompt + 历史）
  pushContext(ws, sessionId, entry);
  process.stderr.write(
    `[host] 加载会话 ${sessionId.slice(0, 8)} cwd=${entry.cwd} 历史 ${transcript.length} 条\n`,
  );
}

async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // 全部 project 目录，pinned 优先
  const byProject = new Map<string, any[]>();
  for (const s of all) {
    const list = byProject.get(s.cwd) ?? [];
    list.push(s);
    byProject.set(s.cwd, list);
  }
  // 历史扫描：新出现的 project 并入所有项目列表（启动/UI 重连时都会走到这里）
  if (mergeHistoryProjects([...byProject.keys()])) await saveDesktopProjects();
  const projects = [...byProject.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: s.firstMessage.slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
    }),
  );
}

// 前端随 prompt 下发的附件：图片为 base64，文本类为文件内容
interface PromptAttachment {
  kind: "image" | "text";
  mime?: string;
  data?: string; // image：base64（无 data: 前缀）
  name?: string; // text：文件名
  text?: string; // text：文件内容
}

async function handlePrompt(
  ws: { send(data: string): unknown },
  sessionId: string,
  text: string,
  files?: PromptAttachment[],
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  // 附件：图片走 SDK ImageContent；文本类文件内容内联进 prompt（与 CLI 粘贴文件一致）
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const f of files ?? []) {
    if (f.kind === "image" && typeof f.data === "string") {
      images.push({ type: "image", data: f.data, mimeType: String(f.mime ?? "image/png") });
    }
  }
  const textBlocks = (files ?? [])
    .filter((f) => f.kind === "text" && typeof f.text === "string")
    .map((f) => {
      const name = String(f.name ?? "file").replace(/"/g, "&quot;");
      return `<attached-file name="${name}">\n${f.text}\n</attached-file>`;
    });
  let finalText = text;
  if (textBlocks.length > 0) {
    finalText = text ? `${textBlocks.join("\n\n")}\n\n${text}` : textBlocks.join("\n\n");
  }
  if (!finalText && images.length === 0) throw new Error("消息为空");
  if (!finalText) finalText = "请查看附件图片。";
  entry.transcript.push({ role: "user", text: finalText });
  // 命令立即返回；turn 产物全部走事件流。流式中经 streamingBehavior 排队为 followUp
  // （当前 loop 完全自动消费触发新 turn，不打断进行中的处理；idle 时该参数被底座忽略照常开 turn）
  entry.session
    .prompt(finalText, {
      ...(images.length > 0 ? { images } : {}),
      streamingBehavior: "followUp",
    })
    .then(() => sendQueued(ws, sessionId, entry)) // 入队/开 turn 后校准前端排队行
    .catch((err: unknown) => {
      ws.send(JSON.stringify({ type: "error", sessionId, message: String(err) }));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

// ---------- 排队消息 RPC ----------
// 队列语义（仿 ZCode）：流式中发送的消息默认排队（followUp，当前 loop 完全处理完
// 后自动消费第 1 条触发新 prompt）；「立即发送」把某条转为 steer（当前工具批次后注入）。
// 索引一律指「用户消息」在对应队列过滤序列中的下标（跳过系统 notice，与 queued 帧一致）。

function sendQueued(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const agent = entry.session.agent;
  const view = (list: readonly any[]) =>
    list.filter((m) => isUserQueuedMessage(m)).map((m) => toRestoredQueuedMessage(m));
  const followUp = view(agent.peekFollowUpQueue());
  const steering = view(agent.peekSteeringQueue());
  // 竞态兜底的快照：两队列用户消息全量（turn_end 时 diff「上次有/现在无/未通知消费」= 被吞）
  entry.queuedTexts = [...followUp, ...steering].map((m) => m.text);
  ws.send(JSON.stringify({ type: "queued", sessionId, followUp, steering }));
}

function handlePeekQueued(ws: { send(data: string): unknown }, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  sendQueued(ws, sessionId, entry);
}

// 移除第 index 条用户消息及其紧邻在前的隐藏伴随（图片描述等），返回过滤后的新数组
function removeUserMessage(queue: readonly any[], index: number): any[] {
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`排队消息不存在: ${index}`);
  let start = target;
  while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
  return queue.filter((_, i) => i < start || i > target);
}

function handleDropQueued(
  ws: { send(data: string): unknown },
  sessionId: string,
  which: "followUp" | "steering",
  index?: number,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = which === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
  let next: any[];
  if (index === undefined) {
    // 全清：只清用户消息及其隐藏伴随，保留系统 notice（goal/plan/budget 等）
    next = queue.filter((m) => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m));
  } else {
    next = removeUserMessage(queue, index);
  }
  agent.replaceQueues(
    which === "steering" ? next : agent.peekSteeringQueue(),
    which === "steering" ? agent.peekFollowUpQueue() : next,
  );
  sendQueued(ws, sessionId, entry);
}

// 立即发送：把 followUp 队列第 index 条转为 steer（经 session.steer 重新入队，保留图片）
async function handleSendNow(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekFollowUpQueue();
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`排队消息不存在: ${index}`);
  const restored = toRestoredQueuedMessage(queue[target]);
  agent.replaceQueues(agent.peekSteeringQueue(), removeUserMessage(queue, index));
  await entry.session.steer(restored.text, restored.images);
  sendQueued(ws, sessionId, entry);
}

// 放回队列：把 steer 队列第 index 条挪回 followUp 顶端（去掉 steer 标记）
function handleRequeue(ws: { send(data: string): unknown }, sessionId: string, index: number) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  const agent = entry.session.agent;
  const queue = agent.peekSteeringQueue();
  let n = -1;
  let target = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!isUserQueuedMessage(queue[i])) continue;
    if (++n === index) {
      target = i;
      break;
    }
  }
  if (target < 0) throw new Error(`steer 消息不存在: ${index}`);
  const moved: any = { ...queue[target] };
  delete moved.steering;
  agent.replaceQueues(removeUserMessage(queue, index), [moved, ...agent.peekFollowUpQueue()]);
  sendQueued(ws, sessionId, entry);
}

process.on("SIGTERM", async () => {
  // Tauri 壳退出兜底；dispose 触发落盘收尾
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
  process.exit(0);
});

// 父进程死亡自监测：tauri dev 杀进程树时壳的 Exit 回调可能来不及 kill，
// 宿主轮询 ppid，父进程消失就自行退出，杜绝孤儿进程
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 2000);

console.log(`READY ws://127.0.0.1:${server.port}`);

// 配额后台刷新:启动时预载所有已配置供应商(模型目录里出现过的 provider),
// 此后每 5 分钟按账号全量重拉;缓存 TTL 同为 5min,前台 hover/切页永远命中缓存,
// 对供应商的实际请求频率严格等于本节奏。
const LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function configuredLimitProviders() {
  const seen = new Map<string, string>();
  for (const m of H.availableModels) {
    if (seen.has(m.provider)) continue;
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(m.provider) ?? "";
    } catch {}
    seen.set(m.provider, baseUrl);
  }
  return [...seen].map(([id, baseUrl]) => ({ id, baseUrl }));
}
const runLimitsRefresh = () => {
  const providers = configuredLimitProviders();
  void refreshAllLimits(H.authStorage, providers).then(() => {
    process.stderr.write(`[host] 配额预载/刷新完成: ${providers.length} 个供应商\n`);
  });
};
runLimitsRefresh();
setInterval(runLimitsRefresh, LIMITS_REFRESH_INTERVAL_MS);
