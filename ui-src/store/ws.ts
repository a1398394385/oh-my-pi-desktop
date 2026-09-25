// WS 连接与事件路由 slice：ws/connected/connText、send、connect 重试环、onMessage 全帧 switch、
// 全局错误上报。自 store.ts 平移（P3 波 2）；session 域重逻辑下沉 store/session.ts，
// 终端帧直推 store/terminal.ts。过渡期容器 mutate + bump（等价旧 notify）。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import {
  activateSession,
  activeOpen,
  admitStampedEvent,
  applyEvent,
  applySteerConsumed,
  clearBranchingMarks,
  findBySessionId,
  hostInstanceReset,
  notifyDesktop,
  ingestModelDefaults,
  ingestModels,
  rebuildMessages,
  applyDelta,
  updateSession,
} from "./session";
import { emitTerminalFrame } from "./terminal";
import type { ApprovalMode, HostFrame, McpAssetsPayload } from "../types/frames";
import type { OpenSession } from "../types/session";
import type { SchemaDef } from "../components/settings/placement";

export interface WsSlice {
  ws: WebSocket | null;
  connected: boolean;
  connText: string;
  send(obj: unknown): void;
  setConnected(ok: boolean, text: string): void;
  connect(): Promise<void>;
}

export const createWsSlice: StateCreator<AppStore, [], [], WsSlice> = (set, get) => ({
  ws: null,
  connected: false,
  connText: "连接中…",

  send(obj: unknown): void {
    const ws = get().ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  },
  setConnected(ok: boolean, text: string): void {
    set((s) => ({ connected: ok, connText: text }));
  },
  async connect(): Promise<void> {
    if (!invoke) {
      get().setConnected(false, "无宿主");
      return;
    }
    get().setConnected(false, "连接中…");
    // 宿主冷启动可能 >15s(模型目录走代理刷新阻塞 READY):ws_url 失败不放弃,
    // 周期重试直到拿到端口(BUG-008:曾表现为 profile 菜单 fallback 单项)
    let url: string;
    try {
      url = await invoke("ws_url");
    } catch {
      setTimeout(() => void get().connect(), 3000);
      return;
    }
    const ws = new WebSocket(url);
    set({ ws });
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onopen = () => {
      get().setConnected(true, "已连接");
      get().send({ type: "list_sessions" });
      // 启动时欢迎页先于连接渲染，get_git_branches 曾被 send 丢弃；连接就绪后补拉
      if (get().isCreatingNew && get().newSessionProject) get().send({ type: "get_git_branches", cwd: get().newSessionProject });
      // 设置页若在连接就绪前打开，4 个数据请求被 send 丢弃；连接就绪后补拉
      if (get().settingsOpen) get().refreshSettingsData();
    };
    // 断线后自动重连(3s),宿主重启期间 UI 不至于永久停留在旧状态
    ws.onclose = () => {
      get().setConnected(false, "已断开");
      setTimeout(() => void get().connect(), 3000);
    };
    ws.onerror = () => get().setConnected(false, "已断开");
  },
});

// Tauri 壳注入的全局对象（浏览器直连调试时不存在）。invoke 返回形状随命令而异、
// event 载荷为宿主/壳消息，均为真实外部边界：默认 any，调用点按需收窄。
declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      event?: { listen: (event: string, handler: (e: { payload?: any }) => void) => Promise<unknown> };
    };
  }
}

export const invoke = window.__TAURI__?.core?.invoke;

// ---------- 事件路由 ----------
// msg 为宿主 WS 帧;入口 JSON.parse 结果即 HostFrame 判别联合(types/frames 镜像发送端构造)。
// 未识别帧运行期存在(宿主新版本超前),switch default 兜底静默忽略——穷尽检查靠 default 内的
// never 断言:HostFrame 新增成员而此处漏接时编译期报错。
function onMessage(msg: HostFrame): void {
  const st = useAppStore.getState();
  // 带位置戳的主动推送先过守卫（RPC 响应无 hi 不受影响）
  const stamped = msg as { hi?: string; seq?: number }; // 戳字段仅部分帧携带,守卫只读不写,不破坏后续判别
  if (stamped.hi !== undefined && !admitStampedEvent(stamped)) return;
  switch (msg.type) {
    case "ready": {
      // 握手帧不占 seq：仅在实例变化时重置；重连（同 hi）保留已见位置避免假跳号
      if (msg.hi && st.evtHost !== msg.hi) hostInstanceReset(msg.hi, 0);
      // approvalMode 在宿主侧为未收窄字符串(SettingsSnapshot.approvalMode 同),三值校验在宿主
      const approvalMode = (msg.approvalMode as ApprovalMode | undefined) ?? st.approvalMode;
      ingestModels(msg.models);
      useAppStore.setState({ approvalMode });
      // 启动即进欢迎页时 ready 帧晚于首次 initNewSessionModel：配置默认到位后立即重校准
      if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
        useAppStore.getState().initNewSessionModel(true);
      }
      if (msg.settings) {
        // 字段级白名单合并：host 设置帧只有 hideThinkingBlock 影响本地外观偏好
        if (typeof msg.settings.hideThinkingBlock === "boolean") {
          useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
        }
        useAppStore.setState({ hostSettings: msg.settings });
      }
      break;
    }
    case "models": {
      ingestModels(msg.models);
      if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
        useAppStore.getState().initNewSessionModel(true);
      }
      break;
    }
    case "models_catalog":
      useAppStore.setState((s) => ({ modelCatalog: msg.models ?? [] }));
      break;
    case "model_roles":
      useAppStore.setState((s) => ({ modelRoles: msg.roles ?? [] }));
      break;
    case "settings": {
      if (typeof msg.settings?.hideThinkingBlock === "boolean") {
        useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
      }
      useAppStore.setState({ hostSettings: msg.settings });
      if (msg.restartHint) useAppStore.getState().toast("已保存，部分网络设置建议重启应用后完全生效");
      break;
    }
    case "settings_schema":
      // 宿主 schema 条目即 SETTINGS_SCHEMA 形状(与 SchemaDef 对齐),帧侧暂为粗形,边界处收窄
      useAppStore.setState((s) => ({ settingsSchema: msg.schema as Record<string, SchemaDef> }));
      break;
    case "profile_switched": {
      useAppStore.setState((s) => ({
        openSessions: new Map(),
        activePath: null,
        selectedSubagent: null,
        selectedFile: null,
      }));
      useAppStore.getState().toast(`已激活 Profile: ${msg.profile}`);
      break;
    }
    case "usage_stats":
      useAppStore.setState((s) => ({ usageStats: msg.stats }));
      break;
    case "agent_assets":
      useAppStore.setState((s) => ({ agentAssets: msg.assets }));
      break;
    case "extensions":
      useAppStore.setState((s) => ({
        extensions: msg,
        extensionsByScope: { ...s.extensionsByScope, [msg.scope]: msg },
      }));
      break;
    case "approval_mode":
      useAppStore.setState((s) => ({ approvalMode: msg.mode }));
      break;
    case "plan_mode": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.planMode = !!msg.enabled;
        },
        false,
      );
      break;
    }
    case "approval_request": {
      updateSession(msg.sessionId, (s) => {
        s.pendingApprovals ??= [];
        s.pendingApprovals.push({
          requestId: msg.requestId,
          title: msg.title,
          options: msg.options,
          editable: !!msg.editable,
          prefill: msg.prefill ?? "",
          answer: null,
        });
      });
      const s = findBySessionId(msg.sessionId);
      if (s) notifyDesktop("approval", s, "等待审批", msg.title);
      break;
    }
    case "approval_resolved": {
      useAppStore.setState((st2) => {
        const openSessions = new Map(st2.openSessions);
        for (const [p, s] of openSessions) {
          if (s.pendingApprovals) {
            openSessions.set(p, { ...s, pendingApprovals: s.pendingApprovals.filter((request) => request.requestId !== msg.requestId) });
          }
        }
        return { openSessions };
      });
      break;
    }
    case "session_list": {
      // 归档条目拆出：不进 diskProjects，单独存 archivedSessions 供侧栏归档区渲染
      const st2 = useAppStore.getState();
      const archived: typeof st2.archivedSessions = [];
      const diskProjects: typeof st2.diskProjects = [];
      for (const p of msg.projects) {
        const sessions = [];
        for (const r of p.sessions) {
          if (r.archived) archived.push({ ...r, cwd: p.cwd });
          else sessions.push(r);
        }
        diskProjects.push({ ...p, sessions });
      }
      archived.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
      const expandedProjects = new Set<string>(msg.expandedProjects ?? []);
      if (st2.isProjectManageMode) {
        for (const p of diskProjects) expandedProjects.add(p.cwd);
      }
      useAppStore.setState((s) => ({
        diskProjects,
        archivedSessions: archived,
        allProjects: msg.allProjects ?? [],
        removedProjects: msg.removedProjects ?? [],
        expandedProjects,
        pinnedSessions: new Set<string>(msg.pinnedSessions ?? []),
      }));
      const st3 = useAppStore.getState();
      if (st3.activePath && !diskProjects.some((p) => p.sessions.some((r) => r.path === st3.activePath))) {
        useAppStore.setState((s) => {
          if (!s.activePath) return {};
          const openSessions = new Map(s.openSessions);
          openSessions.delete(s.activePath);
          return { openSessions, activePath: null };
        });
        useAppStore.getState().showWelcomeScreen(useAppStore.getState().newSessionProject || useAppStore.getState().getAvailableProjects()[0]?.cwd);
      }
      break;
    }
    case "session_model": {
      updateSession(msg.sessionId, (s) => {
        s.model = msg.model;
        if (msg.thinking) s.thinking = msg.thinking;
      });
      break;
    }
    case "session_thinking": {
      updateSession(msg.sessionId, (s) => {
        s.thinking = msg.level;
      });
      break;
    }
    // ---- 输入框 sigil：斜杠命令清单（宿主 list_commands 回包；list_files 的 @ 候选回包） ----
    case "commands":
      useAppStore.setState((s) => ({
        commands: Array.isArray(msg.commands) ? msg.commands : [],
        commandsSessionId: msg.sessionId ?? "new", // 无会话回包 = 新建页清单
      }));
      break;
    case "file_matches": {
      if (msg.reqId !== useAppStore.getState().mentionReqSeq) break; // 过期响应：用户已继续输入，丢弃
      useAppStore.setState((s) => ({
        mentionResult: { reqId: msg.reqId, matches: Array.isArray(msg.matches) ? msg.matches : [] },
      }));
      break;
    }
    case "session_created": {
      useAppStore.setState((s) => ({
        openSessions: new Map(s.openSessions).set(msg.path, {
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          items: [],
          pendingApprovals: [],
          assistantDraft: "",
          streaming: false,
          turnStartAt: null,
          subagents: new Map(),
          model: msg.model ?? null,
          thinking: msg.thinking ?? "auto",
          isGit: !!msg.isGit,
          todos: [],
          goal: null, // goal 状态（宿主 goal 帧置位；会话状态卡目标区展示）
          planMode: false, // 计划模式（宿主 plan_mode 帧置位）
        } as OpenSession),
        selectedSubagent: null,
        selectedFile: null,
        isCreatingNew: false,
      }));
      activateSession(msg.path);
      useAppStore.getState().refreshGitDiff(); // 右栏 Git Diff 页需要 git status 数据，提前预取
      const st3 = useAppStore.getState();
      if (st3.pendingNewPrompt) {
        const { text, files } = st3.pendingNewPrompt;
        useAppStore.setState({ pendingNewPrompt: null });
        const s = st3.openSessions.get(st3.activePath ?? "");
        if (s) {
          updateSession(s.sessionId, (next) => {
            next.items.push({ role: "user", text });
          });
          st3.ws!.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
          // 钉底跟随由 Chat 组件的滚动 effect 处理
        }
      }
      if (st3.pendingCreate) {
        useAppStore.setState({ pendingCreate: false });
        st3.send({ type: "list_sessions" }); // 新会话已落盘，重拉列表
      }
      break;
    }
    // 宿主检出外部进程写入本会话（CLI 对话/改名）：置位提示条，直到重新加载。
    // 会话被前端 LRU 驱逐时帧丢弃，切回走池复用分支时宿主按 entry.externalWrite 补发
    case "session_external_write": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.externalWrite = true;
        },
        false,
      );
      break;
    }
    case "git_branches": {
      if (msg.cwd !== st.newSessionProject) break;
      useAppStore.setState((s) => ({
        newSessionIsGit: !!msg.isGit,
        newSessionBranch: msg.current || "",
        newSessionBranches: msg.branches || [],
      }));
      break;
    }
    case "git_branch_switched": {
      if (msg.cwd !== st.newSessionProject) break;
      useAppStore.setState((s) => ({ newSessionBranch: msg.branch }));
      useAppStore.getState().toast(`已切换分支到 ${msg.branch}`);
      break;
    }
    case "event":
      applyEvent(msg);
      break;
    case "messages":
      rebuildMessages(msg);
      break;
    // ---- 输入框 sigil：本地 bash 执行帧（! 前缀，宿主 bash_exec 驱动） ----
    case "bash_start": {
      updateSession(msg.sessionId, (s) => {
        s.items.push({ role: "bash", text: msg.command, output: "", running: true, excludeFromContext: !!msg.excludeFromContext });
      });
      break;
    }
    case "bash_chunk": {
      const s = findBySessionId(msg.sessionId);
      if (!s) return;
      const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
      if (it) {
        // 流式输出合并渲染（与 text_delta 同款 100ms 节流:就地 mutate,窗口 flush 换引用）
        applyDelta(msg.sessionId, (next) => {
          const target = [...next.items].reverse().find((x): x is Extract<(typeof next.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
          if (target) target.output = (target.output || "") + msg.chunk;
        });
      }
      break;
    }
    case "bash_done": {
      updateSession(msg.sessionId, (s) => {
        const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
        // bash_abort 会先收到一帧 cancelled:true 的 done，可能与正式 done 重复——
        // 以最后一次为准，第二次找不到 running 项时静默忽略
        if (!it) return;
        it.running = false;
        if (msg.error != null) {
          it.error = String(msg.error);
        } else {
          it.output = msg.output ?? it.output;
          it.exitCode = msg.exitCode ?? null;
          it.cancelled = !!msg.cancelled;
          it.timedOut = !!msg.timedOut;
          it.truncated = !!msg.truncated;
        }
      });
      break;
    }
    // 斜杠命令的文本输出（如 /model 的 Current model 回显）：落一条 meta 行
    case "command_output": {
      updateSession(msg.sessionId, (s) => {
        s.items.push({ role: "meta", text: String(msg.text ?? "") });
      });
      break;
    }
    // 后台命令阶段行:start 插入执行中行;fail 撤该命令的执行中行。
    // 完成态不走瞬时帧:由落盘痕转出的 phase 行随 messages 重建到达(单一事实来源)
    case "command_phase": {
      updateSession(msg.sessionId, (s) => {
        if (msg.phase === "start") {
          s.items.push({ role: "phase", phase: "start", command: msg.command, text: String(msg.text ?? "") });
        } else {
          const pending = s.items.findIndex(
            (it) => it.role === "phase" && it.phase === "start" && it.command === msg.command,
          );
          if (pending >= 0) s.items.splice(pending, 1);
        }
      });
      break;
    }
    // 斜杠命令被宿主本地消费：撤回乐观插入的 user 气泡（无 entryId 的最后一条同文本）
    case "command_result": {
      updateSession(msg.sessionId, (s) => {
        if (msg.consumed) {
          for (let i = s.items.length - 1; i >= 0; i--) {
            const it = s.items[i];
            if (it.role === "user" && it.text === msg.text && !it.entryId) {
              s.items.splice(i, 1);
              break;
            }
          }
        }
      });
      break;
    }
    case "subagent_lifecycle": {
      updateSession(msg.sessionId, (s) => {
        // 底座在结束时（completed/failed/aborted）会用同一 subagentId 重发 lifecycle——
        // 只更新状态保留累积内容，否则完成后详情被清空
        const prev = s.subagents.get(msg.subagentId);
        s.subagents.set(msg.subagentId, {
          agent: msg.agent,
          description: msg.description ?? "",
          status: msg.status,
          // host 补齐的派生字段：显示名 / 父 agent / 注册时刻
          name: msg.name ?? prev?.name,
          parent: msg.parent ?? prev?.parent,
          registeredAt: msg.registeredAt ?? prev?.registeredAt,
          text: prev?.text ?? "",
          tools: prev?.tools ?? [],
          streaming: msg.status === "started",
          // progress 帧累积的用量字段（lifecycle 重发时保留）
          usage: prev?.usage,
        });
      });
      break;
    }
    case "subagent_progress": {
      updateSession(
        msg.sessionId,
        (s) => {
          // 聚合用量帧（host 已 500ms 节流）：成本/时长/请求/工具数/token/上下文/当前步骤
          const prev = s.subagents.get(msg.subagentId);
          if (!prev) return;
          prev.usage = {
            cost: msg.cost,
            durationMs: msg.durationMs,
            requests: msg.requests,
            toolCount: msg.toolCount,
            tokens: msg.tokens,
            contextTokens: msg.contextTokens,
            contextWindow: msg.contextWindow,
            currentTool: msg.currentTool,
            currentToolArgs: msg.currentToolArgs,
            currentToolStartMs: msg.currentToolStartMs,
            lastIntent: msg.lastIntent,
            resolvedModel: msg.resolvedModel,
            resolvedThinkingLevel: msg.resolvedThinkingLevel,
            recentTools: msg.recentTools,
          };
          if (msg.status) prev.status = msg.status;
          if (msg.name && !prev.name) prev.name = msg.name;
          if (msg.parent && !prev.parent) prev.parent = msg.parent;
          if (msg.registeredAt && !prev.registeredAt) prev.registeredAt = msg.registeredAt;
        },
        false,
      );
      break;
    }
    case "subagent_event": {
      // 文本 delta 高频:就地 mutate + 100ms 窗口 flush(与主对话 text_delta 同款)
      if (msg.kind === "text_delta") {
        applyDelta(msg.sessionId, (s) => {
          const sub = s.subagents.get(msg.subagentId);
          if (sub) sub.text += msg.text;
        });
        break;
      }
      updateSession(
        msg.sessionId,
        (s) => {
          const sub = s.subagents.get(msg.subagentId);
          if (!sub) return;
          if (msg.kind === "turn_start") sub.streaming = true;
          else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId, running: true });
          else if (msg.kind === "tool_update") {
            const last =
              [...sub.tools].reverse().find((t) => t.toolCallId && t.toolCallId === msg.toolCallId) ||
              [...sub.tools].reverse().find((t) => t.name === msg.name);
            if (last)
              Object.assign(last, {
                files: uniqueFiles(msg.files ?? last.files),
                added: msg.added,
                removed: msg.removed,
                todo: msg.todo,
                output: msg.output ?? last.output,
                details: msg.details ?? last.details,
                diffContent: msg.diffContent ?? last.diffContent,
                running: false,
              });
          } else if (msg.kind === "turn_end") sub.streaming = false;
        },
        false,
      );
      break;
    }
    case "git_status": {
      const dirs = new Set<string>();
      for (const f of msg.files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      useAppStore.setState((s) => ({
        gitDiffCache: { cwd: msg.cwd, files: msg.files, loading: false },
        rightState: { ...s.rightState, expandedDirs: dirs },
      }));
      break;
    }
    case "todos": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.todos = msg.phases ?? [];
        },
        false,
      );
      break;
    }
    case "goal": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.goal = msg.goal ?? null;
        },
        false,
      );
      break;
    }
    case "queued": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.queued = msg.followUp ?? [];
          s.steering = msg.steering ?? [];
        },
        false,
      );
      break;
    }
    case "steer_consumed":
      applySteerConsumed(msg);
      break;
    case "file_diff": {
      useAppStore.setState((s) => ({
        fileDiffCache: { path: msg.path, diff: msg.diff, loading: false },
        briefDiffPending: s.briefDiffPending === msg.path ? null : s.briefDiffPending,
      }));
      useAppStore.getState().setBriefDiff(msg.path, msg.diff); // 同一份回包同时喂给编辑行内联展开
      break;
    }
    case "file_content": {
      // 文件页全文件内容回包：无条件写入（用户可能已切走 tab）
      useAppStore.setState((s) => {
        if (!s.fileView || s.fileView.path !== msg.path) return { fileViewPending: null };
        const fv = { ...s.fileView };
        if (msg.error) fv.error = msg.error;
        else Object.assign(fv, { text: msg.text, startLine: 1, lineNumbers: null, full: true, error: null });
        return { fileViewPending: null, fileView: fv };
      });
      break;
    }
    case "dir_list": {
      // 文件树单层回包：填充缓存（嵌套容器换新引用,订 rightState 的 selector 才能感知）
      useAppStore.setState((s) => ({
        rightState: {
          ...s.rightState,
          fileTreePending: new Set([...s.rightState.fileTreePending].filter((p) => p !== msg.path)),
          fileTreeDirs: new Map(s.rightState.fileTreeDirs).set(msg.path, msg.entries ?? []),
        },
      }));
      break;
    }
    case "context": {
      updateSession(
        msg.sessionId,
        (s) => {
          s.ctx = { tokens: msg.tokens, window: msg.window, percent: msg.percent };
        },
        false,
      );
      break;
    }
    case "session_stats": {
      updateSession(
        msg.sessionId,
        (s) => {
          // 整会话统计（host 在 turn 收尾与加载会话时推送）：输入框下方状态行常驻显示
          s.stats = {
            tokens: msg.tokens,
            cost: msg.cost,
            cacheHitRate: msg.cacheHitRate,
            advisorCost: msg.advisorCost,
            activeMs: msg.activeMs,
          };
        },
        false,
      );
      break;
    }
    case "context_detail":
      // ringpop 弹卡瞬态数据，CtxCard 订阅重绘（卡收起时更新不重建，移开即弃）
      useAppStore.setState((s) => ({ ctxDetail: msg }));
      break;
    case "limits_result":
      useAppStore.setState((s) => ({ ctxLimits: msg }));
      break;
    case "provider_limits_result": {
      // 模型管理页配额：按选中供应商落地，组件按 providerLimits 渲染（防旧响应污染由组件判 provider）
      if (msg.provider === useAppStore.getState().selectedProvider) {
        useAppStore.setState((s) => ({ providerLimits: msg }));
      }
      break;
    }
    case "all_providers":
      useAppStore.setState((s) => ({ allProvidersCache: msg.providers ?? [] }));
      break;
    case "login_progress":
      if (msg.reqId !== st.loginReqId) break;
      useAppStore.setState((s) => ({ loginBanner: `${msg.provider}：${msg.message}` }));
      break;
    case "login_prompt":
      if (msg.reqId !== st.loginReqId) break;
      useAppStore.setState((s) => ({ loginPromptData: msg }));
      break;
    case "login_done": {
      if (msg.reqId !== st.loginReqId) break;
      if (msg.ok) {
        useAppStore.getState().toast(`${msg.provider} 登录成功，模型列表已刷新`);
        useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null, mpAddView: false }));
      } else if (msg.cancelled) {
        useAppStore.getState().toast("登录已取消");
        useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
      } else {
        useAppStore.getState().toast(`${msg.provider} 登录失败：${msg.message}`);
        useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
      }
      break;
    }
    case "provider_key_done":
      useAppStore.getState().toast(`${msg.provider} API key 已保存，模型列表已刷新`);
      useAppStore.setState((s) => ({ mpDetailProv: null }));
      useAppStore.getState().send({ type: "get_all_providers" });
      break;
    case "models_config_path":
      useAppStore.getState().toast(`配置文件：${msg.path}`);
      break;
    case "asset_file":
      // skills/agents/mcp 编辑器共用帧，全量落地，页面按 kind 过滤（每次赋新对象触发 effect）。
      // 补 type 字段构造完整帧对象(kind 缺省兜底为原行为);新对象引用驱动「已保存」态复位
      useAppStore.setState((s) => ({
        assetFile: { type: "asset_file", kind: msg.kind ?? "agent", path: msg.path, content: msg.content },
      }));
      break;
    case "memory_file": {
      // 首次目录级读取带 files；行展开/rollout 只回 content（旧版 memInbox 语义平移）
      useAppStore.setState((s) => {
        const md = s.memoryDetail;
        const next = msg.files
          ? {
              ...md,
              base: msg.path,
              files: msg.files,
              rollouts: msg.rollouts ?? [],
              active: { name: msg.file, rollout: false },
            }
          : { ...md };
        next.content = msg.content;
        next.status = "done";
        next.error = null;
        return { memoryDetail: next };
      });
      break;
    }
    case "asset_file_saved": {
      const at = Date.now();
      useAppStore.setState((s) => ({ assetFileSaved: { kind: msg.kind, at }, assetSaved: { kind: msg.kind, at } }));
      useAppStore.getState().send({ type: "list_agent_assets" });
      break;
    }
    case "asset_file_deleted":
      useAppStore.getState().toast(msg.kind === "skill" ? "技能已删除" : "文件已删除");
      break;
    case "mcp_server_tested": {
      // 旧版 handleMcpServerTested 平移：测试结果落地 + 行状态点同步 + toast（全量换引用）
      useAppStore.setState((st) => {
        // mcp 段逐字段形状随底座扫描函数(frames.ts TODO),此处只取 servers 数组的测试相关字段
        const mcp = st.agentAssets?.mcp as { servers?: { name: string; status?: string; error?: string }[] } | undefined;
        const servers = mcp?.servers;
        const srv = servers?.find((x) => x.name === msg.name);
        const mcpTestResults = { ...st.mcpTestResults, [msg.name]: { status: msg.status, error: msg.error, ts: Date.now() } };
        if (!srv || !servers || !mcp) return { mcpTestResults };
        const nextServers = servers.map((x) =>
          x === srv ? { ...x, status: msg.status === "ok" ? "connected" : "error", error: msg.error } : x,
        );
        return {
          mcpTestResults,
          // mcp 经窄类型 as 读 servers(spread 运行期保留全部字段),静态侧断言还原完整负载类型
          agentAssets: { ...st.agentAssets!, mcp: { ...mcp, servers: nextServers } as McpAssetsPayload },
        };
      });
      useAppStore.getState().toast(msg.status === "ok" ? `MCP [${msg.name}] 连接成功` : `MCP [${msg.name}] 探测失败: ${msg.error || ""}`);
      break;
    }
    case "session_renamed":
      if (msg.ok) {
        useAppStore.getState().toast("已重命名");
        useAppStore.getState().send({ type: "list_sessions" }); // 列表数据以宿主为唯一真源，重拉最稳
      } else {
        // 帧形状无 error 字段(ok 恒 true,失败路径仅防御兜底);断言只为补类型,不改运行期读取
        const renamedErr = msg as { error?: string };
        useAppStore.getState().toast(renamedErr.error ?? "重命名失败");
      }
      break;
    case "session_archived":
      if (msg.ok) {
        useAppStore.getState().toast(msg.archived ? "已归档" : "已取消归档");
        useAppStore.getState().send({ type: "list_sessions" });
      } else {
        const archivedErr = msg as { error?: string }; // 同上:仅防御性兜底
        useAppStore.getState().toast(archivedErr.error ?? "归档操作失败");
      }
      break;
    case "session_aborted":
      useAppStore.getState().toast("已停止生成");
      break;
    case "session_compacted":
      useAppStore.getState().toast(msg.ok ? "上下文已压缩" : (msg.error ?? "压缩失败"));
      break;
    case "session_branched": {
      // 分叉回执：清除防连点标记（items mutate,空补丁换引用通知）；transcript 由 load_session 推的 messages 帧重建
      {
        const cur = activeOpen();
        if (cur) {
          clearBranchingMarks(cur.items);
          updateSession(cur.sessionId, () => {});
        }
      }
      if (!msg.ok) {
        useAppStore.getState().toast(msg.error ?? "分叉失败");
        break;
      }
      useAppStore.getState().toast("已分叉到新分支");
      useAppStore.getState().setComposerValue(msg.selectedText ?? "", msg.selectedImages);
      useAppStore.getState().send({ type: "load_session", path: msg.newPath }); // 复用磁盘会话加载链路
      useAppStore.getState().send({ type: "list_sessions" });
      break;
    }
    case "session_tree": {
      useAppStore.setState((s) => ({
        rightState: {
          ...s.rightState,
          sessionTree: { sessionId: msg.sessionId ?? s.rightState.treeFor, branches: msg.branches ?? [] },
          sessionTreePending: false,
        },
      }));
      break;
    }
    case "entry_tree": {
      useAppStore.setState((s) => ({
        rightState: {
          ...s.rightState,
          entryTree: { sessionId: msg.sessionId ?? s.rightState.entryTreeFor, leafId: msg.leafId ?? null, roots: msg.roots ?? [] },
          entryTreePending: false,
        },
      }));
      break;
    }
    case "session_navigated": {
      // 树内导航回执：transcript 由 messages 帧重建；成功后条目树作废重拉
      //（被放弃路径已成为兄弟分支，旧树结构失效），user 消息原文回填输入框（重问）
      const st2 = useAppStore.getState();
      {
        const cur = activeOpen();
        if (cur) {
          clearBranchingMarks(cur.items);
          updateSession(cur.sessionId, () => {});
        }
      }
      const fromFork = st2.rightState.navFrom === "fork"; // 分叉与树页跳转共用 navigate_tree，按来源给文案
      useAppStore.setState((s) => ({
        rightState: { ...s.rightState, entryTreeNav: false, navFrom: null, entryTree: msg.ok ? null : s.rightState.entryTree },
      }));
      if (!msg.ok) {
        useAppStore.getState().toast(msg.error ?? (fromFork ? "分叉失败" : "跳转失败"));
        break;
      }
      useAppStore.getState().toast(fromFork ? "已从该处分叉" : "已跳转到所选节点");
      if (msg.editorText) useAppStore.getState().setComposerValue(msg.editorText, msg.editorImages);
      break;
    }
    case "image_content": {
      useAppStore.setState((s) => ({ rightState: { ...s.rightState, imageContent: msg } }));
      break;
    }
    case "git_staged":
    case "git_unstaged":
    case "git_discarded":
    case "git_committed":
    case "git_pushed": {
      useAppStore.setState((s) => ({ rightState: { ...s.rightState, gitWrite: msg } })); // 回包驱动按钮 busy 态收口
      if (msg.type === "git_staged" || msg.type === "git_unstaged" || msg.type === "git_discarded") {
        if (msg.ok) {
          if (msg.type === "git_discarded") useAppStore.getState().toast("已丢弃更改");
          useAppStore.getState().refreshGitDiff();
        } else useAppStore.getState().toast(msg.error ?? "git 操作失败");
      } else if (msg.type === "git_committed") {
        if (msg.ok) {
          useAppStore.getState().toast(`已提交 ${(msg.commit ?? "").slice(0, 7)}`);
          useAppStore.getState().refreshGitDiff();
        } else useAppStore.getState().toast(msg.error ?? "提交失败");
      } else {
        useAppStore.getState().toast(msg.ok ? "已推送" : (msg.error ?? "推送失败"));
      }
      break;
    }
    case "terminal_created":
    case "terminal_data":
    case "terminal_exit":
      // PTY 输出/退出帧：直推终端页订阅者（帧高频，不走 bump 全量重渲染）
      emitTerminalFrame(msg);
      break;
    case "error": {
      useAppStore.setState((s) => ({
        gitDiffCache: { ...s.gitDiffCache, loading: false },
        rightState: { ...s.rightState, sessionTreePending: false }, // 分支树请求失败解除挂起，下次渲染重拉
      }));
      // 设置中心资产/记忆读取失败的错误落地（旧版写 aeStatus / 记忆行内态）
      if (msg.kind) useAppStore.setState((s) => ({ assetErr: { kind: msg.kind!, message: msg.message, at: Date.now() } }));
      const md = useAppStore.getState().memoryDetail;
      if (md.status === "loading") {
        useAppStore.setState((s) => ({
          memoryDetail: { ...s.memoryDetail, status: "error", error: msg.message },
        }));
      }
      const sid = msg.sessionId;
      if (sid && findBySessionId(sid)) {
        updateSession(sid, (next) => {
          next.items.push({ role: "error", text: msg.message });
        });
      } else {
        useAppStore.getState().toast(msg.message);
      }
      break;
    }
    default: {
      // 穷尽检查:以上分支覆盖 HostFrame 全部成员;HostFrame 新增帧类型而漏接时,
      // msg 无法缩窄为 never,此处编译期报错。运行期未知帧维持既有兜底:静默忽略。
      const _exhaustive: never = msg;
      void _exhaustive;
      break;
    }
  }
}

// 工具行文件清单去重（subagent_event 的 tool_update 分支用）
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
}

// WKWebView 无 console：未捕获错误上报宿主日志 + toast
window.onerror = (msg) => {
  useAppStore.getState().toast(String(msg).slice(0, 120));
  useAppStore.getState().send({ type: "ui_error", message: String(msg).slice(0, 300) });
};
window.addEventListener("unhandledrejection", (e) => {
  useAppStore.getState().send({ type: "ui_error", message: "unhandledrejection: " + String(e.reason).slice(0, 300) });
});

export { onMessage };
