// 会话生命周期域：create/load 两条入口（池复用与磁盘重建）、事件接线（attachEntry 的
// 审批 UI 上下文 + 扩展 runner 注入 + 子代理 eventBus 转发 + 排队竞态兜底）、
// 快照推送族（goal/todos/context/stats）。自 main.ts 平移（拆分第二刀）。
import path from "node:path";
import fs from "node:fs";
import {
  createAgentSession,
  AgentRegistry,
  SessionManager,
  USER_INTERRUPT_LABEL,
  isUserQueuedMessage,
  toRestoredQueuedMessage,
} from "./bootstrap.ts";
import {
  H,
  sessions,
  defaultCwd,
  stampEvent,
  pendingApprovals,
  requestApproval,
  pushCommandOutput,
  type PoolEntry,
  type TranscriptItem,
} from "./state.ts";
import { GoalController, type GoalSession } from "./goal.ts";
import { AcpSessionState, parseAcpContextWindow } from "./acp-state.ts";
import { createAcpContextExtension, ACP_SYSTEM_PROMPT } from "./acp-context.ts";
import { createAcpCompressTools } from "./acp-tools.ts";
import { createSessionContextTools } from "./session-context.ts";
import { translateEvent, translateSubagentEvent, entriesToTranscript, sumRunDurationMs } from "./translate.ts";
import { readAcpRaw, readAcpEnabled, readAcpNudgeConfig, readSessionContextEnabled } from "./profile.ts";
import { readPluginsEnabled, readHooksEnabled } from "./assets.ts";
import { sendQueued, releaseOneParked } from "./queue.ts";
import { pushPlanMode, reconcilePlanMode } from "./plan.ts";

export function isGitWorktree(cwd: string): boolean {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && p.stdout.toString().trim() === "true";
}

// 池外会话的磁盘解析：扫全部会话文件（与 list_sessions 同源），按底座会话 id 匹配
// 出文件路径。用于对未打开的历史会话做 rename/archive 等操作。
export async function sessionPathFromDisk(sessionId: string): Promise<string> {
  const hit = (await SessionManager.listAll()).find((s: any) => s.id === sessionId);
  if (!hit) throw new Error(`会话不存在: ${sessionId}`);
  return hit.path;
}

// 复制会话工件目录（如生成的代码片段、图表等）：会话文件同名的无后缀目录
export async function copySessionArtifactsIfAny(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
  if (!sourceSessionFile.endsWith(".jsonl") || !destinationSessionFile.endsWith(".jsonl")) return;
  const srcDir = sourceSessionFile.slice(0, -6);
  const dstDir = destinationSessionFile.slice(0, -6);
  if (path.resolve(srcDir) === path.resolve(dstDir)) return;
  try {
    const st = await fs.promises.stat(srcDir);
    if (st.isDirectory()) {
      await fs.promises.cp(srcDir, dstDir, { recursive: true });
    }
  } catch {}
}

/** goal 状态帧：会话状态卡顶部目标区展示（无 goal 推 null，前端连分隔线一起隐藏）。 */
function pushGoal(sessionId: string) {
  const entry = sessions.get(sessionId);
  const w = entry?.attachedWs as { send(data: string): unknown } | null;
  if (!entry || !w) return;
  const state = entry.session.getGoalModeState();
  w.send(
    JSON.stringify({
      type: "goal",
      sessionId,
      goal: state?.goal
        ? {
            objective: state.goal.objective,
            status: state.goal.status,
            enabled: state.enabled === true,
            tokenBudget: state.goal.tokenBudget ?? null,
            tokensUsed: state.goal.tokensUsed,
            timeUsedSeconds: state.goal.timeUsedSeconds,
            costUsed: entry.goal.costUsed,
          }
        : null,
    }),
  );
}

/** 待办清单帧：冷加载/池内复用均推（TodoTracker 构造时已从 transcript 分支同步）。
    前端 session_created 重建对象后靠它回填历史存量；空清单不推（无卡）。 */
function pushTodos(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const phases = entry.session.getTodoPhases();
  if (phases.length > 0) {
    ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases })));
  }
}

export function pushContext(ws: any, sessionId: string, entry: PoolEntry) {
  const u = entry.session.getContextUsage();
  if (u) {
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "context",
          sessionId,
          tokens: u.tokens,
          window: u.contextWindow,
          percent: u.percent,
        }),
      ),
    );
  }
}

// 会话累计统计（TUI status-line 的 token/cache/cost/time 段汇总）：输入框下方状态行常驻显示。
// 与上下文明细卡（get_context_detail 的 breakdown/stats）不同，这里是「整会话」口径：
// tokens 含历史累加，时长含进行中窗口
function buildSessionStats(entry: PoolEntry) {
  const st = entry.session.getSessionStats();
  // 缓存利用率（TUI cache_hit 段同款公式）：cacheRead/(cacheRead+cacheWrite+input)。
  // 分母含未命中 input，Anthropic/OpenRouter（miss 记 input）与 DeepSeek（miss 记 input、
  // cacheWrite 为 0）都还原成 hit/(hit+miss)
  const promptTokens = st.tokens.input + st.tokens.cacheRead + st.tokens.cacheWrite;
  return {
    tokens: st.tokens,
    cost: st.cost,
    cacheHitRate: promptTokens > 0 ? st.tokens.cacheRead / promptTokens : 0,
    // TUI cost 段同款：会话总成本 = 主会话成本 + advisor 成本（未启用 advisor 时为 0）
    advisorCost: entry.session.getAdvisorCost(),
    // 活跃时长含进行中窗口（与 TUI getActiveMs 一致：空闲墙钟不计）
    activeMs: entry.activeMs + (entry.activeStartedAt === null ? 0 : Date.now() - entry.activeStartedAt),
  };
}

function pushSessionStats(ws: any, sessionId: string, entry: PoolEntry) {
  ws.send(JSON.stringify({ type: "session_stats", sessionId, ...buildSessionStats(entry) }));
}

export async function createSessionCore(cwd: string, sessionManager: any, transcript: TranscriptItem[], initialModel?: any) {
  const acpState = new AcpSessionState();
  // 实验性功能页的总开关（omp-desktop.json 的 acp.enabled，默认开启）：只决定本会话
  // 是否注入 ACP 工具面与 context 视图改写；会话创建后无法热切换，故开关变更对新会话生效
  const acpEnabled = readAcpEnabled();
  // 历史会话检索开关（omp-desktop.json 的 sessionContext.enabled，实验性功能页可关）
  const sessionContextEnabled = readSessionContextEnabled();
  // nudge 分母：omp-desktop.json 的 acp.contextWindow（固定值，如 2000000 / "1M"）
  // 优先于模型注册表窗口；两者皆未知则 nudge 整体禁用
  const sessionModel = (initialModel ?? H.modelOverride) as { contextWindow?: number; contextLength?: number } | undefined;
  acpState.modelContextWindow =
    parseAcpContextWindow((readAcpRaw()?.acp as Record<string, unknown> | undefined)?.contextWindow) ||
    Number(sessionModel?.contextWindow ?? sessionModel?.contextLength ?? 0) ||
    0;
  acpState.nudge = readAcpNudgeConfig();
  // system prompt 防复读段（acp.systemPrompt，实验性功能页可开，默认关）：只在
  // ACP 启用时追加；opencode-acp 原版默认注入，这里做成显式开关留给用户
  const acpSystemPrompt = acpEnabled && (readAcpRaw().acp as { systemPrompt?: unknown } | undefined)?.systemPrompt === true;
  const result = await createAgentSession({
    cwd,
    authStorage: H.authStorage,
    modelRegistry: H.modelRegistry,
    settings: H.settings,
    model: initialModel ?? H.modelOverride,
    systemPrompt: acpSystemPrompt ? (defaultPrompt: string[]) => [...defaultPrompt, ACP_SYSTEM_PROMPT] : undefined,
    agentRegistry: new AgentRegistry(), // 默认全局 registry 每 generation 只许一个 Main，多会话必传私有实例
    sessionManager, // host 侧 manager 必须注入 SDK：否则 rename/compact/branch 走 entry.manager（孤儿实例）操作到另一个会话文件
    // read_session_context（历史会话检索）：只读自身 profile 的会话，见 host/session-context.ts
    customTools: [
      ...(acpEnabled ? createAcpCompressTools(acpState) : []),
      ...(sessionContextEnabled ? createSessionContextTools() : []),
    ] as never, // ACP 压缩工具（compress/decompress/search_context/acp_status/acp_context_recap），见 host/acp-tools.ts；omptype/ArkType schema 与包类型 TSchema 品牌不兼容，运行时一致
    extensions: acpEnabled ? [createAcpContextExtension(acpState)] : [], // context 事件视图变换：ref 注入 + 压缩块替换，见 host/acp-context.ts
    disableExtensionDiscovery: !(readPluginsEnabled() || readHooksEnabled()),
    enableMCP: false,
    hasUI: true, // 审批 gate 的 fail-cold 判定走 runner.hasUI()：不开则非 yolo 模式下所有需审批工具直接报错
  });
  const { session } = result;
  const sessionId = crypto.randomUUID();
  const entry: PoolEntry = {
    session,
    sessionResult: result, // setToolUIContext 等宿主注入点
    unsubscribe: () => {},
    attachedWs: null,
    providerSessionId: sessionManager.getSessionId?.() ?? sessionId, // 请求侧 getApiKey 的粘性键
    transcript,
    assistantDraft: "", // 当前 turn 的流式文本累积，turn_end 时定稿
    thinkingDraft: "",
    thinkingStartedAt: null,
    activeMs: 0,
    activeStartedAt: null,
    path: session.sessionFile,
    pollKnownSize: 0, // 外部写入检测：0 = 未首扫
    externalWrite: false,
    cwd,
    isGit: isGitWorktree(cwd),
    queuedTexts: [], // 排队消息文本快照（turn_end 竞态兜底）
    consumedTexts: [],
    parkedFollowUp: [], // followUp 暂存区（见 state.ts 类型注释）
    manager: sessionManager, // rename/compact 等需要直接操作 SessionManager 的 RPC 用
    title: sessionManager.getSessionName() ?? null,
    mentionScanIndex: 0,
    goal: new GoalController({
      // SDK 具体会话类型与窄接口的泛型签名不完全结构兼容，边界处收敛为具名窄接口
      session: session as unknown as GoalSession,
      output: (text) => pushCommandOutput(sessionId, text),
      onChange: () => pushGoal(sessionId),
    }),
  };
  return { sessionId, entry, eventBus: result.eventBus };
}

export function attachEntry(ws: any, sessionId: string, entry: PoolEntry, eventBus: any) {
  const unsubSession = entry.session.subscribe((ev) => {
    const ui = translateEvent(ev, entry);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...ui })));
    // todo 工具落盘后推送最新任务清单（TodoTracker 在工具结果后更新）
    if (ev.type === "tool_execution_end" && ev.toolName === "todo") {
      ws.send(JSON.stringify(stampEvent({ type: "todos", sessionId, phases: entry.session.getTodoPhases() })));
    }
    // 关键执行事件实时推送上下文占用，更新前端上下文大小圆环
    if (ev.type === "message_end" || ev.type === "tool_execution_end") {
      pushContext(ws, sessionId, entry);
    }
    // goal 模式钩子：续跑调度与工具集收尾（对齐 TUI #handleGoalSessionEvent 的分支）
    if (ev.type === "agent_start") entry.goal.onAgentStart();
    if (ev.type === "message_start" && ev.message?.role === "user" && !ev.message?.synthetic) entry.goal.onUserMessage();
    if (ev.type === "goal_updated") entry.goal.onGoalUpdated(ev.state);
    // 会话活跃时长计时（TUI status-line time_spent 同款）：agent_start 开窗（幂等，重入不双计），
    // 真正收尾的 agent_end 折窗；isTerminal === false 的中间 agent_end 之后还会续跑，不折
    if (ev.type === "agent_start") {
      if (entry.activeStartedAt === null) entry.activeStartedAt = Date.now();
    } else if (ev.type === "agent_end" && ev.isTerminal !== false && entry.activeStartedAt !== null) {
      entry.activeMs += Math.max(0, Date.now() - entry.activeStartedAt);
      entry.activeStartedAt = null;
    }
    // turn 真正结束后推送上下文占用（此时消息已定稿）；同时校准排队行（steer 已消费）
    if (ev.type === "agent_end" && ev.isTerminal !== false) {
      // fileMention 回读：底座在 prompt() 内部追加 fileMention 消息（请求数组 + 落盘），
      // 没有对应事件；这里扫自 mentionScanIndex 起的新条目转成 mention 帧下发
      const entries = entry.manager.getEntries();
      for (let i = entry.mentionScanIndex; i < entries.length; i++) {
        const e = entries[i];
        if (e?.type === "message" && e.message?.role === "fileMention") {
          const files = (e.message.files ?? []).map((f: { path?: unknown }) => String(f.path ?? ""));
          entry.transcript.push({ role: "mention", text: "", files });
          ws.send(JSON.stringify({ type: "event", sessionId, kind: "mention", files }));
        }
      }
      entry.mentionScanIndex = entries.length;
      pushContext(ws, sessionId, entry);
      pushSessionStats(ws, sessionId, entry);
      // goal 终局评估：完成收尾 / 无进展抑制 / 调度续跑（对齐 TUI #handleGoalSessionEvent）
      void entry.goal.onAgentEnd(ev.messages ?? []);
      // 收尾竞态兜底：底座在 run 收尾 abort 时，正在 claim 的队列消息会被丢弃且不回队
      // （agent.ts #prepareQueuedMessageBatch 的 dequeue-先移出 + abort-不 restore），表现为
      // 「上次快照里有、现在队列没有、dequeue hook 从未通知消费」。host 重新发送该消息。
      // parked 暂存的消息同样计入现存集合——它们不在底座队列是设计使然，不是被吞。
      const a = entry.session.agent as any;
      const cur = [...a.peekFollowUpQueue(), ...entry.parkedFollowUp, ...a.peekSteeringQueue()]
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
          ws.send(JSON.stringify(stampEvent({ type: "error", sessionId, message: String(err) })));
        });
      }
      // 逐轮放回：parked 有剩余时放回 1 条并触发消费（每条独立 turn）。
      // 兜底重发刚起了新 run 的场合（lost 非空）本轮不放，等那个 run 的 agent_end 接续。
      if (lost.length === 0 && entry.parkedFollowUp.length > 0) {
        for (const m of releaseOneParked(entry)) a.followUp(m);
        // agent_end 事件先于 isStreaming 复位的窗口里 continue 会 busy：等 idle 后补一次
        a.continue().catch(() => {
          a.waitForIdle?.()
            .then(() => a.continue())
            .catch((err: unknown) => {
              process.stderr.write(`[host] 排队消息续轮触发失败: ${String(err)}\n`);
            });
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
      return requestApproval(
        ws,
        sessionId,
        title,
        options.map((o) => (typeof o === "string" ? o : o.label)),
        dialogOptions?.signal,
      );
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
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title: `${title}\n${message}`,
              options: ["OK", "Cancel"],
            }),
          ),
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
          JSON.stringify(
            stampEvent({
              type: "approval_request",
              sessionId,
              requestId,
              title,
              options: ["提交", "取消"],
              editable: true,
              prefill: prefill ?? "",
            }),
          ),
        );
      });
    },
  };
  entry.sessionResult.setToolUIContext(uiCtx, true);
  // 关键一步（ACP 同款，acp-agent.ts:2631）：runner.hasUI() 判的是 initialize 注入的 uiContext，
  // 只调 setToolUIContext 不够——审批 gate 会 fail-closed「no interactive UI」。
  //
  // actions / contextActions 必须给全：runner.initialize 把 contextActions.getModel 直接赋给内部
  // #getModel（runner.ts:695，没有 ?? 兜底），传空对象会让它变成 undefined；此后任何经
  // createCustomToolContext 求值 ctx.model 的 customTool（sdk.ts:987）都抛
  // 「getModel is not a function」——2026-09-23 实测 read_session_context 因此整工具失败。
  // 第三参传 undefined 而不是空对象：空对象同样会把 #waitForIdleFn / #newSessionHandler 等赋成
  // undefined，只有 undefined 才保留 runner 的 no-op 默认（runner.ts:704 `if (commandContextActions)`）。
  entry.session.extensionRunner?.initialize(
    {
      sendMessage: (message, options) => {
        void entry.session.sendCustomMessage(message, options).catch((err: unknown) => {
          process.stderr.write(`[host] 扩展 sendMessage 失败: ${String(err)}\n`);
        });
      },
      sendUserMessage: (content, options) => {
        void entry.session.sendUserMessage(content, options);
      },
      appendEntry: (customType, data) => {
        entry.session.sessionManager.appendCustomEntry(customType, data);
      },
      setLabel: (targetId, label) => {
        entry.session.sessionManager.appendLabelChange(targetId, label);
      },
      getActiveTools: () => entry.session.getEnabledToolNames(),
      getAllTools: () => entry.session.getAllToolInfos(),
      setActiveTools: async (toolNames) => {
        await entry.session.setActiveToolsByName(toolNames);
      },
      // 桌面无扩展命令面：UI 命令清单走 pushCommands 的 buildAvailableSlashCommands 独立路径
      getCommands: () => [],
      setModel: async (model) => {
        if (!(await entry.session.modelRegistry.getApiKey(model))) return false;
        await entry.session.setModel(model);
        return true;
      },
      getThinkingLevel: () => entry.session.thinkingLevel,
      setThinkingLevel: (level) => entry.session.setThinkingLevel(level),
      getServiceTiers: () => entry.session.serviceTierByFamily,
      setServiceTier: (family, tier) => entry.session.setServiceTierFamily(family, tier),
      getSessionName: () => entry.session.sessionManager.getSessionName(),
      setSessionName: async (name) => {
        await entry.session.sessionManager.setSessionName(name, "user");
      },
    },
    {
      getModel: () => entry.session.model,
      isIdle: () => !entry.session.isStreaming,
      abort: () => {
        void entry.session.abort({ reason: USER_INTERRUPT_LABEL });
      },
      hasPendingMessages: () => entry.session.queuedMessageCount > 0,
      shutdown: () => {},
      getContextUsage: () => entry.session.getContextUsage(),
      getSystemPrompt: () => entry.session.systemPrompt,
      compact: async () => {
        await entry.session.compact();
      },
    },
    undefined, // 命令上下文动作：桌面未接扩展命令面，保留 runner 默认 no-op
    uiCtx,
    "rpc",
  );

  // 整棵 spawn 树共享根会话的 eventBus（sdk.ts:1341）：子代理 lifecycle/event/progress 帧都在上面。
  // host 侧补齐的派生数据（AgentProgress 本身没有的）：
  //   registeredAt —— lifecycle started 帧到达时刻（详情卡 Registered 时间戳）
  //   name / parent —— task 工具调用的 args 里带子代理名，toolCallId 记归属方
  //                   （根会话=Main，子代理流里=该子代理），parentToolCallId 反查「Spawned by X」
  const subRegistered = new Map<string, number>(); // subagentId -> started 时刻
  const subSpawnCall = new Map<string, string>(); // subagentId -> 父 task toolCallId
  const callOwner = new Map<string, { owner: string; names: string[] }>(); // task toolCallId -> 归属 + spawn 的子代理名
  const spawnTools: Record<string, true> = { task: true, agent: true };
  const spawnNames = (args: Record<string, unknown>): string[] => {
    const items = Array.isArray(args.tasks) ? args.tasks : [args];
    return items.map((t) => (t && typeof t === "object" && "name" in t && typeof t.name === "string" ? t.name : undefined)).filter((n): n is string => !!n);
  };
  const subName = (id: string, agent: string): string => {
    const call = callOwner.get(subSpawnCall.get(id) ?? "");
    return call?.names[0] ?? agent;
  };
  const subParent = (id: string): string => {
    const spawnCall = subSpawnCall.get(id);
    if (!spawnCall) return "Main";
    const owner = callOwner.get(spawnCall);
    return owner?.owner ?? "Main";
  };
  // 根会话里的 task 调用：归属 Main
  const unsubSpawnRoot = entry.session.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start" && spawnTools[ev.toolName]) {
      callOwner.set(ev.toolCallId, { owner: "Main", names: spawnNames(ev.args) });
    }
  });
  const unsubLifecycle = eventBus.on("task:subagent:lifecycle", (p: any) => {
    if (p.parentToolCallId) subSpawnCall.set(p.id, p.parentToolCallId);
    if (p.status === "started") subRegistered.set(p.id, Date.now());
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "subagent_lifecycle",
          sessionId,
          subagentId: p.id,
          agent: p.agent,
          description: p.description,
          status: p.status,
          name: subName(p.id, p.agent),
          parent: subParent(p.id),
          registeredAt: subRegistered.get(p.id),
          detached: p.detached ?? false,
        }),
      ),
    );
    // 终态帧后补发最后一帧 progress（节流可能压掉），保证结束时成本/token 落到最终值
    if (p.status !== "started") {
      const last = subLastProgress.get(p.id);
      if (last) ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, ...last }));
    }
  });
  // 聚合进度帧：成本/时长/请求/工具/token/上下文（高频且累积，500ms 节流；状态变化立即发）
  const subLastProgress = new Map<string, Record<string, unknown>>();
  const subSentAt = new Map<string, number>();
  const subSentStatus = new Map<string, string>();
  const unsubProgress = eventBus.on("task:subagent:progress", (p: any) => {
    const pr = p.progress ?? {};
    const payload = {
      agent: p.agent,
      status: pr.status,
      task: pr.task,
      cost: pr.cost,
      durationMs: pr.durationMs,
      requests: pr.requests,
      toolCount: pr.toolCount,
      tokens: pr.tokens,
      contextTokens: pr.contextTokens,
      contextWindow: pr.contextWindow,
      currentTool: pr.currentTool,
      currentToolArgs: pr.currentToolArgs,
      currentToolStartMs: pr.currentToolStartMs,
      lastIntent: pr.lastIntent,
      resolvedModel: pr.resolvedModel,
      resolvedThinkingLevel: pr.resolvedThinkingLevel,
      recentTools: pr.recentTools,
    };
    subLastProgress.set(p.id, payload);
    const now = Date.now();
    const statusChanged = subSentStatus.get(p.id) !== pr.status;
    if (!statusChanged && now - (subSentAt.get(p.id) ?? 0) < 500) return;
    subSentAt.set(p.id, now);
    subSentStatus.set(p.id, pr.status);
    ws.send(JSON.stringify({ type: "subagent_progress", sessionId, subagentId: p.id, name: subName(p.id, p.agent), parent: subParent(p.id), registeredAt: subRegistered.get(p.id), ...payload }));
  });
  const unsubEvents = eventBus.on("task:subagent:event", ({ id, event }: any) => {
    // 子代理流里的 task 调用：归属该子代理（嵌套 spawn）
    if (event.type === "tool_execution_start" && spawnTools[event.toolName]) {
      callOwner.set(event.toolCallId, { owner: subName(id, id), names: spawnNames(event.args) });
    }
    const ui = translateSubagentEvent(event);
    if (ui) ws.send(JSON.stringify(stampEvent({ type: "subagent_event", sessionId, subagentId: id, ...ui })));
  });
  // 消费前通知：即将注入的排队/steer 用户消息推给 UI（气泡转正）；同时记入已消费
  // 清单，供 turn_end 的收尾竞态兜底 diff 排除（hook 触发 ≠ 注入成功，但不重复重发）
  const detachDequeueHook = entry.session.agent.addBeforeQueuedMessageDequeueHook(() => {
    const texts = [...entry.session.agent.peekFollowUpQueue(), ...entry.session.agent.peekSteeringQueue()]
      .filter((m) => isUserQueuedMessage(m))
      .map((m) => toRestoredQueuedMessage(m).text);
    if (texts.length > 0) {
      entry.consumedTexts.push(...texts);
      ws.send(JSON.stringify(stampEvent({ type: "steer_consumed", sessionId, texts })));
    }
  });
  // 监听底座会话标题变更（模型自动生成标题或 /rename 等）
  const unsubTitle = entry.session.sessionManager.onSessionNameChanged?.(() => {
    const title = entry.session.sessionManager.getSessionName() ?? "";
    entry.title = title || null;
    ws.send(JSON.stringify({ type: "session_title_changed", sessionId, title }));
  });
  entry.unsubscribe = () => {
    unsubSession();
    unsubTitle?.();
    unsubSpawnRoot();
    unsubLifecycle();
    unsubProgress();
    unsubEvents();
    detachDequeueHook();
  };
  entry.attachedWs = ws;
  sessions.set(sessionId, entry);
}

export async function handleCreateSession(ws: any, cwd?: string, modelStr?: string, thinkingLevel?: string) {
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
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
      title: entry.title ?? null,
    }),
  );
  pushPlanMode(ws, sessionId, entry);
  process.stderr.write(`[host] 新建会话 ${sessionId.slice(0, 8)} cwd=${workDir} model=${modelStr ?? "default"} thinking=${thinkingLevel ?? "default"}（活跃 ${sessions.size}）\n`);
}

export async function handleLoadSession(ws: any, sessionPath: string) {
  if (!sessionPath) throw new Error("缺少 path");
  // 池内已有同 path 条目：复用，不重建。重建会让同一会话文件被两个 AgentSession 同时
  // 持有（各自落盘互相覆盖），旧条目连同它的订阅一并泄漏在池里。
  // 命中路径：前端会话 LRU 驱逐后切回（同一 ws，只重推快照）；前端 reload 后点击
  // （新 ws，重挂订阅——旧订阅发往已关闭的连接，事件会丢）。
  for (const [sessionId, entry] of sessions.entries()) {
    if (entry.path !== sessionPath) continue;
    if (entry.attachedWs !== ws) {
      entry.unsubscribe(); // 先解旧订阅，否则同一事件会发两份
      attachEntry(ws, sessionId, entry, entry.sessionResult.eventBus);
    }
    ws.send(
      JSON.stringify({
        type: "session_created",
        sessionId,
        path: entry.path,
        cwd: entry.cwd,
        model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
        isGit: entry.isGit,
        title: entry.title ?? null,
      }),
    );
    pushPlanMode(ws, sessionId, entry); // 复用快照同推计划状态（前端 reload 后靠它显示「计划」按钮）
    ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
    pushTodos(ws, sessionId, entry); // 复用快照同推待办存量（否则前端重建对象后历史 TODO 不展示）
    pushGoal(sessionId); // goal 状态存量（会话状态卡目标区）
    pushContext(ws, sessionId, entry);
    pushSessionStats(ws, sessionId, entry); // 复用快照同推整会话统计（否则前端重建对象后 stats 为空）
    if (entry.externalWrite) ws.send(JSON.stringify({ type: "session_external_write", sessionId })); // LRU 驱逐期间检出的，切回时补发
    process.stderr.write(`[host] 复用池内会话 ${sessionId.slice(0, 8)}（活跃 ${sessions.size}）\n`);
    return;
  }
  const manager = await SessionManager.open(sessionPath);
  const entries = manager.getEntries();
  const transcript = entriesToTranscript(entries);
  // 会话原始 cwd：getEntries() 不含 session header，用 peekSessionInit 读
  // （open 内部同源；目录不可达时它返回 null，兜底 HOME）
  const peek = await SessionManager.peekSessionInit(sessionPath);
  const workCwd = peek?.cwd ?? defaultCwd;
  const { sessionId, entry, eventBus } = await createSessionCore(workCwd, manager, transcript);
  // 历史 mention 已在 transcript 里：fileMention 回读游标对齐到全量条目尾，避免首轮回读重发
  entry.mentionScanIndex = entries.length;
  // 历史会话的活跃时长初值：内存计时器只覆盖本次打开后的时间，从磁盘条目按轮次累加补上存量
  entry.activeMs = sumRunDurationMs(entries);
  attachEntry(ws, sessionId, entry, eventBus);
  ws.send(
    JSON.stringify({
      type: "session_created",
      sessionId,
      path: entry.path,
      cwd: entry.cwd,
      model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
      thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      isGit: entry.isGit,
      title: entry.title ?? null,
    }),
  );
  reconcilePlanMode(ws, sessionId, entry, entries); // 落盘 mode_change 恢复计划模式（必须在 session_created 之后推帧）
  await entry.goal.restore(); // 目标模式恢复（落盘 mode_change goal/goal_paused；对齐 TUI 不主动续跑）
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: transcript }));
  // 恢复会话的存量任务清单（TodoTracker 构造时从 transcript 分支同步）
  pushTodos(ws, sessionId, entry);
  pushGoal(sessionId); // goal 状态存量（restore 之后推送，会话状态卡目标区）
  // 恢复会话的初始上下文占用（system prompt + 历史）
  pushContext(ws, sessionId, entry);
  // 恢复会话的整会话统计（tokens/cost 从磁盘 assistant 消息的 usage 累加；时长为内存态，重载后从 0 起算）
  pushSessionStats(ws, sessionId, entry);
  process.stderr.write(
    `[host] 加载会话 ${sessionId.slice(0, 8)} cwd=${entry.cwd} 历史 ${transcript.length} 条\n`,
  );
}
