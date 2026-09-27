// 会话 slice：openSessions 容器与当前会话指针、模型目录容器、事件流守卫（hi/seq）、
// event 帧处理、排队/steer 消息、LRU 闸门、系统通知。自 store.ts 平移（P3 波 2）。
// 过渡期容器引用恒定（mutate + bump 兜底，波 3 组件切 selector 时改换引用）。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { invoke } from "./ws";
import type { ApprovalMode, EventFrame, MessagesFrame, PromptAttachment, TurnUsage } from "../types/frames";
import type { AssistantItem, ChatItem, LoopItem, OpenSession, ThinkingItem, ToolArgs, ToolDetails, ToolItem, UserItem } from "../types/session";
import type { SessionItem } from "../types/session";

// 经 ws slice 的发送 helper(引用恒定,等价旧顶层 send)
const send = (obj: unknown): void => {
  useAppStore.getState().send(obj);
};

/** setTimeout 句柄(DOM 与 Node 环境返回类型不同,统一别名) */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface SessionSlice {
  activePath: string | null;
  selectedSubagent: string | null;
  approvalMode: ApprovalMode;
  evtHost: string | null; // host 进程实例 ID（ready.hi / 盖戳事件.hi）；变化 = host 已重启
  evtSeq: number; // 该实例下已应用的最高事件序号（位置落后的事件直接丢弃）
  pendingCreate: boolean;
  pendingNewPrompt: { text: string; files: PromptAttachment[] } | null;
  openSessions: Map<string, OpenSession>; // path -> {sessionId,cwd,items,assistantDraft,streaming,subagents,...}
  modelNames: Map<string, string>; // "provider/id" -> 显示名（原 composer.js 平移）
  modelEfforts: Map<string, string[]>; // "provider/id" -> 思考档位列表
}

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = () => ({
  activePath: null,
  selectedSubagent: null,
  approvalMode: "always-ask",
  evtHost: null,
  evtSeq: 0,
  pendingCreate: false,
  pendingNewPrompt: null,
  openSessions: new Map(),
  modelNames: new Map(),
  modelEfforts: new Map(),
});

// ---------- 公共工具（session 域） ----------
export function isJunkPlaceholder(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

/** 工具行的展开态字段（渲染层按种类各取其一：终端/后台/设备行 cmdExpanded、编辑行 diffExpanded、
    读取行 readExpanded，见 chat/ToolRow.jsx 与 chat/EditRow.jsx）——「运行中默认展开」按此落字段 */
export function toolExpandKey(name: string | null | undefined): "readExpanded" | "diffExpanded" | "cmdExpanded" {
  if (name === "read" || name === "grep" || name === "glob" || name === "ls") return "readExpanded";
  if (name === "edit" || name === "write" || name === "apply_patch") return "diffExpanded";
  return "cmdExpanded";
}

// 工具行文件清单去重（原 tool-rows.js uniqueFiles 平移；store 的 tool 处理需要）
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
}

/** 会话的不可变更新（P3）：拷贝 session（按需连 items 数组）→ 回调 mutate 拷贝 →
 *  换 openSessions Map 引用（订阅 session/字段的 selector 按引用感知）。 */
export function updateSession(sessionId: string, fn: (s: OpenSession) => void, withItems = true): void {
  useAppStore.setState((st) => {
    let hit: string | undefined;
    for (const [p, v] of st.openSessions) {
      if (v.sessionId === sessionId) {
        hit = p;
        break;
      }
    }
    if (hit === undefined) return {};
    const cur = st.openSessions.get(hit);
    if (!cur) return {};
    const next = withItems ? { ...cur, items: cur.items.slice() } : { ...cur };
    fn(next);
    return { openSessions: new Map(st.openSessions).set(hit, next) };
  });
}

// ---------- 定位与激活 ----------
export function activeOpen(): OpenSession | undefined {
  const st = useAppStore.getState();
  return st.activePath ? st.openSessions.get(st.activePath) : undefined;
}

export function findBySessionId(id: string): OpenSession | undefined {
  for (const s of useAppStore.getState().openSessions.values()) if (s.sessionId === id) return s;
  return undefined;
}

// ---------- 渲染内存闸门：openSessions 的 LRU 淘汰 ----------
/** 已打开会话的常驻上限。被驱逐的会话在用户切回时由 load_session 链路重新加载
    （SessionRow / BranchTreePage 均已实现「未打开走宿主加载」分支），宿主会话池不受影响。 */
const OPEN_SESSIONS_MAX = 8;

/** 激活会话：置为当前会话并标记最近使用，随后按上限驱逐 */
export function activateSession(path: string): void {
  useAppStore.setState((st) => {
    const cur = st.openSessions.get(path);
    const openSessions = new Map(st.openSessions);
    if (cur) {
      openSessions.delete(path);
      openSessions.set(path, cur);
    }
    return { openSessions, activePath: path, mainViewMode: "chat" };
  });
  scheduleEvict();
}

/** 统一切换/打开会话：清新建态、关闭欢迎页、移除未读、激活会话或拉取加载并刷新 Git Diff */
export function openSessionByPath(path: string, cwd?: string): void {
  useAppStore.setState({ isCreatingNew: false });
  useAppStore.getState().hideWelcomeScreen();
  useAppStore.setState((st) => ({
    unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)),
  }));
  useAppStore.getState().saveUnseen();
  if (cwd) useAppStore.getState().expandProject(cwd);
  if (useAppStore.getState().openSessions.has(path)) {
    activateSession(path);
    useAppStore.getState().refreshGitDiff();
  } else {
    useAppStore.getState().send({ type: "reload_settings" });
    useAppStore.getState().send({ type: "load_session", path });
  }
  useAppStore.setState({ selectedSubagent: null, selectedFile: null });
}

// 延迟驱逐（合并多次触发）。必须延迟而不是同步：宿主在 runEnd 后可能**立刻续轮**
// （parked followUp 放回 + a.continue()，见 host.ts 的 attachEntry），同步驱逐会抢在
// 续轮的 turn_start 帧之前把会话踢出 openSessions，后续帧 findBySessionId 找不到即丢弃，
// 表现为会话在 UI 上卡死。等一小段让续轮帧先到（到了会把 streaming 设回 true，自然受保护）。
let evictTimer: TimerHandle | undefined;
function scheduleEvict(): void {
  clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    evictTimer = undefined;
    evictOpenSessions();
  }, 3000);
}

/** 超限驱逐：从最久未激活的一端开始，跳过当前会话与流式中的会话
    （流式会话被驱逐会丢掉后续 event 帧——findBySessionId 找不到即丢弃）。 */
export function evictOpenSessions(): void {
  useAppStore.setState((st) => {
    if (st.openSessions.size <= OPEN_SESSIONS_MAX) return {};
    const openSessions = new Map(st.openSessions);
    for (const [p, s] of openSessions) {
      if (openSessions.size <= OPEN_SESSIONS_MAX) break;
      if (p === st.activePath || s.streaming) continue;
      openSessions.delete(p);
    }
    return { openSessions };
  });
}

// 清除分叉/导航的防连点标记（item.branching 随 item 数据存活），递归进 loop 组
export function clearBranchingMarks(items: SessionItem[]): void {
  for (const it of items) {
    if (it.role === "assistant" && it.branching) it.branching = false;
    if (it.role === "loop" && it.items) clearBranchingMarks(it.items);
  }
}

// 轮收尾 / 宿主重启：把仍标着运行中的工具项复位。中断、异常路径可能收不到 tool_update，
// 不复位就在行上留下永久转圈（与 hostInstanceReset 清「假 spinner」同一目的）
function clearRunningTools(s: OpenSession): void {
  const walk = (list: SessionItem[] | undefined): void => {
    for (const it of list || []) {
      if (it.role === "loop") walk(it.items);
      else if (it.role === "tool" && it.running) it.running = false;
    }
  };
  walk(s.items);
}

// ---------- 模型目录（原 composer.js ingestModels 平移；变更换 Map 引用） ----------
// models 帧是 scopedModels 全量快照（ready / models / 启停推送一致），按帧重建而非合并：
// 合并会让已关闭的模型残留在输入框菜单里
export function ingestModels(models?: { id: string; name?: string | null; efforts?: string[] | null }[]): void {
  useAppStore.setState(() => {
    if (!models?.length) return {};
    const modelNames = new Map<string, string>();
    const modelEfforts = new Map<string, string[]>();
    for (const m of models) {
      modelNames.set(m.id, m.name || m.id);
      if (Array.isArray(m.efforts)) modelEfforts.set(m.id, m.efforts);
    }
    return { modelNames, modelEfforts };
  });
}

export function getSupportedThinkingForModel(modelId: string | null | undefined): string[] {
  const efforts = useAppStore.getState().modelEfforts.get(modelId ?? "") ?? [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

// 从 models/ready 帧提取新建会话配置默认
export function ingestModelDefaults(msg: { defaultModel?: string | null; defaultThinking?: string | null }): boolean {
  const has = "defaultModel" in msg || "defaultThinking" in msg;
  if (!has) return false;
  useAppStore.setState({ defaultModelCfg: msg.defaultModel ?? null, defaultThinkingCfg: msg.defaultThinking ?? null });
  return true;
}

// ---------- 过程封存 / 排队消息（core.js 平移，渲染调用改 bump） ----------
// 把本轮自 turnItemStart 起的过程封存为 loop 组（中间 assistant 留组外），并把
// turnItemStart 重置到组后：用于流式中插入用户消息时的预封存，与 steer 消费续跑
export function sealRunItems(s: OpenSession, usage?: TurnUsage | null): void {
  const startIdx = s.turnItemStart ?? s.items.length;
  const runItems = s.items.splice(startIdx);
  let lastA = -1;
  for (let i = runItems.length - 1; i >= 0; i--) {
    if (runItems[i].role === "assistant") {
      lastA = i;
      break;
    }
  }
  const finalOut = lastA >= 0 ? runItems.splice(lastA, 1) : [];
  if (runItems.length) {
    s.items.push({
      role: "loop",
      text: "",
      collapsed: true,
      items: runItems,
      durationSec: s.turnStartAt ? Math.round((Date.now() - s.turnStartAt) / 1000) : null,
      usage: usage ?? null,
    });
  }
  s.items.push(...finalOut);
  s.turnItemStart = s.items.length;
}

function queueIndexOf(list: { text?: string }[] | undefined, text: string | undefined): number {
  return (list ?? []).findIndex((m) => (m.text || "") === text);
}

// 删除：出队 + 移除气泡。队列气泡必为 user 条目(pending 标记只落在 UserItem 上),
// 非 user 条目直接进入早退(运行期不会发生,仅为判别联合收窄)
export function dropQueueMsg(s: OpenSession, item: SessionItem): void {
  if (item.role !== "user") return;
  const which = item.pending === "steer" ? "steering" : "followUp";
  const list = which === "steering" ? s.steering : s.queued;
  const i = queueIndexOf(list, item.text);
  if (i < 0 || !list) return; // i >= 0 时 list 必存在(queueIndexOf 对 undefined 恒返回 -1)
  send({ type: "drop_queued", sessionId: s.sessionId, queue: which, index: i });
  updateSession(s.sessionId, (next) => {
    const l = which === "steering" ? next.steering : next.queued;
    const ni = queueIndexOf(l, item.text);
    if (ni >= 0 && l) l.splice(ni, 1); // update 后重查(期间可能有并发帧变更队列)
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}

// 编辑：内容回输入框（composerSetSignal 由 Composer effect 消费），再删除
export function editQueueMsg(s: OpenSession, item: SessionItem): void {
  useAppStore.getState().setComposerValue(item.text ?? "");
  dropQueueMsg(s, item);
}

// 立即发送：排队态转 steer。不截断过程、不预封存——分割只发生在消费时刻
// （steer_consumed 把气泡上方全部过程封存成 loop 组）；气泡由渲染层固定在消息流底部
export function sendNowQueueMsg(s: OpenSession, item: SessionItem): void {
  const i = queueIndexOf(s.queued, item.text);
  if (i < 0) return;
  send({ type: "send_now", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = queueIndexOf(next.queued, item.text);
    if (ni >= 0 && next.queued) next.queued.splice(ni, 1);
    next.steering = next.steering ?? [];
    next.steering.push({ text: item.text });
    next.items.push({ role: "user", text: item.text, pending: "steer" });
  });
}

// 放回队列：steer 态转回排队顶端，气泡同步移除（消息只保留在队列卡中）
export function requeueSteerMsg(s: OpenSession, item: SessionItem): void {
  const i = queueIndexOf(s.steering, item.text);
  if (i < 0) return;
  send({ type: "requeue", sessionId: s.sessionId, index: i });
  updateSession(s.sessionId, (next) => {
    const ni = queueIndexOf(next.steering, item.text);
    if (ni >= 0 && next.steering) next.steering.splice(ni, 1);
    next.queued = next.queued ?? [];
    next.queued.unshift({ text: item.text });
    const j = next.items.lastIndexOf(item);
    if (j >= 0) next.items.splice(j, 1);
  });
}

// ---------- 系统通知（Tauri 壳 send_desktop_notification；事件重复两遍 → 10s 去重） ----------
const notifyLastAt = new Map<string, number>();
export function notifyDesktop(kind: string, s: OpenSession, title: string, body: string): void {
  const now = Date.now();
  const key = `${s.sessionId}:${kind}`;
  if (now - (notifyLastAt.get(key) ?? 0) < 10_000) return;
  notifyLastAt.set(key, now);
  if (!invoke) return; // 非 Tauri 环境（浏览器直连调试）：功能不存在，静默跳过
  const st = useAppStore.getState();
  const path = [...st.openSessions.entries()].find(([, v]) => v === s)?.[0];
  if (path === st.activePath && document.hasFocus()) return;
  invoke("send_desktop_notification", { title, body, sessionId: s.sessionId }).catch((err: unknown) =>
    console.warn("send_desktop_notification:", err),
  );
}

// ---------- 流式增量合并渲染：100ms 窗口内多帧只换引用一次（防高频重渲染打爆主线程） ----------
// delta 帧就地 mutate 当前 session 对象（不经 set，zustand 不感知、零渲染），窗口结束时
// 对累计的会话各做一次浅拷换引用，订阅者统一重渲染——语义与旧「mutate + 延迟 notify」一致。
const pendingDelta = new Set<string>();
let deltaRenderTimer: TimerHandle | undefined;
export function applyDelta(sessionId: string, fn: (s: OpenSession) => void): void {
  const s = findBySessionId(sessionId);
  if (!s) return;
  fn(s);
  pendingDelta.add(sessionId);
  if (deltaRenderTimer) return;
  deltaRenderTimer = setTimeout(() => {
    deltaRenderTimer = undefined;
    const ids = [...pendingDelta];
    pendingDelta.clear();
    for (const id of ids) updateSession(id, () => {}, false); // 空补丁浅拷换引用即通知
  }, 100);
}

// ---------- 事件流位置守卫（host 盖戳 hi/seq 的消费端） ----------
// hi 变化 = host 进程已重启：清掉所有会话的死流式状态（假 spinner / 半截 draft），
// 避免旧实例残留把视图永久挂死；同 hi 内 seq 落后的帧丢弃（位置落后丢弃不合并），
// 跳号只告警不丢帧（重连补洞未实现，先观测）。
export function hostInstanceReset(hi: string | null, seq: number): void {
  useAppStore.setState((st) => {
    if (st.evtHost === null || st.evtHost === hi) {
      return { evtHost: hi, evtSeq: seq };
    }
    // 与 turn_end 的收尾动作对齐（host 死了 = 所有 turn 永远等不到 turn_end）
    const openSessions = new Map<string, OpenSession>();
    for (const [p, s] of st.openSessions) {
      const next = { ...s, items: s.items.slice() }; // items 一并拷贝:复位 running 走 item mutate
      next.assistantDraft = "";
      next.streaming = false;
      next.workingText = null;
      next.turnItemStart = null;
      next.turnStartAt = null;
      next.pendingApprovals = [];
      clearRunningTools(next);
      for (const sub of next.subagents.values()) {
        sub.streaming = false;
        for (const t of sub.tools) t.running = false;
      }
      openSessions.set(p, next);
    }
    return { openSessions, evtHost: hi, evtSeq: seq };
  });
}

/** 盖戳帧携带的位置戳子集(仅 stampEvent 帧有 hi/seq) */
interface EventStampFields {
  hi?: string;
  seq?: number;
}

export function admitStampedEvent(msg: EventStampFields): boolean {
  const st = useAppStore.getState();
  if (st.evtHost !== msg.hi) {
    // hi/seq 成对盖戳(host/host.ts:659-662);缺失时回落 null/0 仅类型兜底,运行期不可达
    hostInstanceReset(msg.hi ?? null, msg.seq ?? 0);
    return true;
  }
  const seq = msg.seq!; // 盖戳帧必有 seq(同上),断言只为收紧类型,运行期语义与原实现一致
  if (seq <= st.evtSeq) return false; // 位置落后：丢弃
  if (seq > st.evtSeq + 1) console.warn(`[evt] 跳号 ${st.evtSeq} → ${seq}（按序放行，仅观测）`);
  useAppStore.setState({ evtSeq: seq });
  return true;
}

// ---------- event 帧处理（原 onMessage case "event" 的全部 kind 分支;updateSession 不可变更新） ----------
export function applyEvent(msg: EventFrame): void {
  const st = useAppStore.getState();
  if (msg.kind === "turn_start") {
    updateSession(
      msg.sessionId,
      (s) => {
        s.streaming = true;
        s.assistantDraft = "";
        s.workingText = "正在处理…";
        // run 首轮才初始化过程起点与计时：轮内续轮(工具循环)不重置,
        // 否则每个模型轮各自成组、时长/usage 全是单轮口径(实时/重载呈现分裂)；
        // 起点可能已由本地发送预置（发送即计时），此处不覆盖
        if (s.turnItemStart == null) {
          s.turnStartAt = s.turnStartAt ?? Date.now();
          s.turnItemStart = s.items.length;
        }
      },
      false,
    );
  } else if (msg.kind === "text_delta") {
    applyDelta(msg.sessionId, (s) => {
      s.assistantDraft += msg.text;
    });
  } else if (msg.kind === "thinking") {
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
        s.items.push({ role: "assistant", text: s.assistantDraft });
      }
      s.assistantDraft = "";
      if (msg.phase === "start") {
        s.workingText = "思考中…";
        s.items.push({ role: "thinking", text: "思考", thinking: "", streaming: true, expanded: st.uiPrefs.showThinking });
      } else {
        const last = [...s.items].reverse().find((it): it is ThinkingItem => it.role === "thinking");
        if (last) {
          last.text = `思考 · ${msg.durationLabel || "持续了几秒"}`;
          last.thinking = msg.thinking || "";
          last.expandable = !!msg.expandable;
          last.streaming = false;
          last.expanded = false; // 思考完成时收起标签
        }
        s.workingText = "正在处理…";
      }
    });
  } else if (msg.kind === "thinking_delta") {
    // 只改最后一个思考 item 的字段;就地 mutate,100ms 窗口 flush 时统一换引用
    applyDelta(msg.sessionId, (s) => {
      const last = [...s.items].reverse().find((it): it is ThinkingItem => it.role === "thinking" && !!it.streaming);
      if (last) last.thinking = (last.thinking || "") + msg.text;
    });
  } else if (msg.kind === "tool") {
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) {
        s.items.push({ role: "assistant", text: s.assistantDraft });
      }
      s.assistantDraft = "";
      const toolItem: SessionItem = {
        role: "tool",
        text: msg.name,
        name: msg.name,
        toolCallId: msg.toolCallId,
        // wire 形状为 Record<string, unknown>,此处收窄为本仓读取字段的上位类型
        args: msg.args as ToolArgs | undefined,
        files: msg.files,
        // tool 帧 = 工具开始执行（args 已到、结果未到），tool_update 帧才置回 false。
        // 所有工具一律置位：结果位在 running 期间渲染 Spin 占位，非 running 才判「无输出」
        running: true,
      };
      // 「工具运行中默认展开」（Ctrl+O）：运行期间展开输出卡，结束时由 tool_update 收起
      if (st.uiPrefs.expandToolOutput) toolItem[toolExpandKey(msg.name)] = true;
      s.items.push(toolItem);
      if (msg.intent) s.workingText = msg.intent;
    });
  } else if (msg.kind === "tool_update") {
    updateSession(msg.sessionId, (s) => {
      const last =
        [...s.items].reverse().find((it): it is ToolItem => it.role === "tool" && !!it.toolCallId && it.toolCallId === msg.toolCallId) ||
        [...s.items].reverse().find((it): it is ToolItem => it.role === "tool" && (it.name || it.text) === msg.name);
      if (last) {
        if (msg.files) last.files = uniqueFiles(msg.files);
        if (msg.added != null) last.added = msg.added;
        if (msg.removed != null) last.removed = msg.removed;
        if (msg.todo) last.todo = msg.todo;
        if (msg.output != null) last.output = msg.output;
        if (msg.details != null) last.details = msg.details as ToolDetails; // wire 为 unknown,收窄为本仓读取字段的上位类型
        if (msg.diffContent != null) last.diffContent = msg.diffContent; // 当次工具真实 diff，编辑行内联展开优先用它
        last.running = false;
        // 「工具运行中默认展开」：结束时收起（运行期自动展开的那张卡）
        if (st.uiPrefs.expandToolOutput) last[toolExpandKey(last.name)] = false;
      }
    });
  } else if (msg.kind === "turn_end") {
    // 轮内帧（runEnd:false，工具循环的每个模型轮）：只收尾草稿，不封存不停表——
    // 整 run 的过程归属一个 loop 组，中间 assistant 留在组内（与重载视图一致）
    if (!msg.runEnd) {
      updateSession(msg.sessionId, (s) => {
        if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
        s.assistantDraft = "";
      });
      return;
    }
    // run 收尾帧（宿主 agent_end 映射，usage 已是整 run 累计、时长取 turnStartAt 起）：
    // 封存一次 + entryId 回填。封存前先复位运行中工具——中断/异常路径可能收不到
    // tool_update，不复位会在行上留下永久转圈
    updateSession(msg.sessionId, (s) => {
      if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
      s.assistantDraft = "";
      // AbortSignal 结束等待时宿主不单独发 approval_resolved，轮结束时清理剩余请求。
      s.pendingApprovals = [];
      s.streaming = false;
      s.workingText = null;
      clearRunningTools(s);
      sealRunItems(s, msg.usage);
      // 宿主在落盘完成后回贴本轮 user 消息的 entryId（消息行分叉按钮的寻址键）；
      // 贴给本轮最后一条无 entryId 的 user 消息（乐观插入的那条）
      if (msg.userEntryId) {
        const u = [...s.items].reverse().find((it): it is UserItem => it.role === "user" && !it.entryId);
        if (u) u.entryId = msg.userEntryId;
      }
      // 本轮 output 末尾 assistant 的 entryId（.turn-acts 分叉按钮的寻址键）：
      // seal 后中间 assistant 已收进 loop 组，顶层只剩这条轮末输出
      if (msg.assistantEntryId) {
        const a = [...s.items].reverse().find((it): it is AssistantItem => it.role === "assistant" && !it.entryId);
        if (a) a.entryId = msg.assistantEntryId;
      }
      // 本轮结束时刻（output 尾部展示）：实时路径取 runEnd 到达时刻，
      // 重载路径由 host 从磁盘条目 timestamp 回填，两者口径一致
      const tailA = [...s.items].reverse().find((it): it is AssistantItem => it.role === "assistant");
      if (tailA && tailA.endMs == null) tailA.endMs = Date.now();
      s.turnItemStart = null; // 本轮彻底结束，不再继续累积
      s.turnStartAt = null;
    });
    // ---- 副作用（数据更新后;updateSession 已带 _v bump） ----
    const st2 = useAppStore.getState();
    const s = findBySessionId(msg.sessionId);
    if (!s) return;
    // 新轮次已落盘（导航后续聊同样走这里）：条目树失效，会话树页下次渲染重拉
    if (st2.rightState.entryTree?.sessionId === msg.sessionId) {
      useAppStore.setState((st3) => ({ rightState: { ...st3.rightState, entryTree: null } }));
    }
    send({ type: "list_sessions" }); // title/firstMessage 可能已更新
    if (s.isGit) st2.refreshGitDiff(true); // agent 可能改了文件，强制重拉
    // 会话已结束：非当前正在查看的会话标记「未查看」，列表显示灰白圆点
    const p = [...st2.openSessions.entries()].find(([, v]) => v === s)?.[0];
    if (p && p !== st2.activePath) {
      useAppStore.setState((st3) => ({ unseenFinished: new Set(st3.unseenFinished).add(p) }));
      useAppStore.getState().saveUnseen();
    }
    // 后台会话完成 → 系统通知：title 取磁盘列表里的会话标题（未收录时「后台会话」），
    // body 取最后一条 assistant 文本截断 80 字作摘要，无则「已完成」
    const lastA = [...s.items].reverse().find((it) => it.role === "assistant" && !isJunkPlaceholder(it.text));
    const summary = (lastA?.text || "").trim();
    notifyDesktop(
      "turn_end",
      s,
      st2.diskProjects.flatMap((pr) => pr.sessions).find((x) => x.id === s.sessionId)?.title || "后台会话",
      summary ? (summary.length > 80 ? summary.slice(0, 80) + "…" : summary) : "已完成",
    );
    // 本会话退出流式态后补一次驱逐：全部会话都在跑时打开新会话，驱逐循环会因「流式
    // 会话受保护」而一个都删不掉；若只在激活时机触发，这些会话跑完后会一直占着内存，
    // 直到用户下次切会话。放在 runEnd 块末尾——上面的未读标记与系统通知都依赖 s 还在
    // openSessions 里（unseenFinished 是按 Map 反查 path 的）。走延迟版：宿主可能
    // 立刻续轮，同步驱逐会抢在续轮帧之前把会话踢掉。
    scheduleEvict();
  } else if (msg.kind === "thinking_level") {
    // auto 档位判定帧：只记判定结果供右下角显示 auto·档位，不改 s.thinking
    if (msg.configured === "auto") {
      updateSession(
        msg.sessionId,
        (s) => {
          s.autoResolved = msg.resolved;
        },
        false,
      );
    }
  } else if (msg.kind === "mention") {
    // @ 提及落盘回读：fileMention 消息无对应流式事件，宿主在 agent_end 重读会话文件补发
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "mention", text: "", files: msg.files || [] });
    });
  }
}

/** 会话内条目的字段补丁（C 批组件用：工具行展开态/loop 折叠态等 item 级切换）。
 *  递归穿透 loop 组定位首个匹配 item,沿途拷贝数组并 mutate 拷贝,换 openSessions 引用。 */
export function patchSessionItem(sessionId: string, match: (it: SessionItem) => boolean, patch: (it: SessionItem) => void): void {
  const walk = (list: SessionItem[]): SessionItem[] | null => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (match(it)) {
        const next = list.slice();
        const copy = { ...it };
        patch(copy);
        next[i] = copy;
        return next;
      }
      if (it.role === "loop" && it.items) {
        const inner = walk(it.items);
        if (inner) {
          const next = list.slice();
          next[i] = { ...it, items: inner };
          return next;
        }
      }
    }
    return null;
  };
  updateSession(sessionId, (s) => {
    const items = walk(s.items);
    if (items) s.items = items;
  });
}

// ---------- steer_consumed 帧处理（队列消费即分割点,原 onMessage case 平移;不可变更新） ----------
export function applySteerConsumed(msg: { sessionId: string; texts?: string[] }): void {
  const prev = findBySessionId(msg.sessionId);
  if (!prev) return;
  updateSession(msg.sessionId, (s) => {
    const bubbles: { bubble: UserItem; loop?: LoopItem }[] = [];
    // 气泡查找要穿透 loop 组：turn_end 可能先于此帧到达并把气泡封进了组里
    const findBubble = (t: string): { bubble: UserItem; loop?: LoopItem } | null => {
      for (let i = s.items.length - 1; i >= 0; i--) {
        const x = s.items[i];
        if (x.role === "loop") {
          const hit = [...(x.items ?? [])]
            .reverse()
            .find((k): k is UserItem => k.role === "user" && !!k.pending && k.text === t);
          if (hit) return { bubble: hit, loop: x };
        } else if (x.role === "user" && x.pending && x.text === t) {
          return { bubble: x };
        }
      }
      return null;
    };
    for (const t of msg.texts ?? []) {
      const found = findBubble(t);
      // 重复消费帧（RPC 重复推送）:该文本已有转正过的气泡则跳过，不重复补画
      if (!found && [...s.items].reverse().some((x) => x.role === "user" && x.steerDone && x.text === t)) continue;
      bubbles.push(found ?? { bubble: { role: "user", text: t } });
      const q = s.queued ?? [];
      const i = q.findIndex((m) => (m.text || "") === t);
      if (i >= 0) q.splice(i, 1);
      const st2 = s.steering ?? [];
      const j = st2.findIndex((m) => (m.text || "") === t);
      if (j >= 0) st2.splice(j, 1);
    }
    const done: UserItem[] = [];
    for (const b of bubbles) {
      const bubble = b.bubble;
      const k = s.items.indexOf(bubble);
      if (k >= 0) s.items.splice(k, 1);
      else if (b.loop) {
        const items = b.loop.items ?? []; // loop 项必有 items 数组（封组装配时建立）
        const ki = items.indexOf(bubble);
        if (ki >= 0) items.splice(ki, 1);
        if (items.length === 0) {
          const li = s.items.indexOf(b.loop);
          if (li >= 0) s.items.splice(li, 1);
        }
      }
      bubble.pending = null;
      bubble.steerDone = true;
      done.push(bubble);
    }
    if (s.assistantDraft && !isJunkPlaceholder(s.assistantDraft)) s.items.push({ role: "assistant", text: s.assistantDraft });
    s.assistantDraft = "";
    sealRunItems(s, null);
    for (const b of done) s.items.push(b);
    s.turnItemStart = s.items.length;
    s.streaming = true;
    s.workingText = "正在处理…";
    s.turnStartAt = Date.now();
  });
}

/** messages 帧重建 transcript（compact/branch/navigate/load 后整体替换,不可变更新） */
export function rebuildMessages(msg: MessagesFrame): void {
  const prev = findBySessionId(msg.sessionId);
  if (!prev) return;
  updateSession(msg.sessionId, (s) => {
    // 执行中分隔行不属于 transcript,重建时保留在尾;同 command 的落盘完成行已到则被吸收
    const pendingPhases = s.items.filter(
      (it) =>
        it.role === "phase" &&
        it.phase === "start" &&
        !msg.messages.some((m) => m.role === "phase" && m.phase === "done" && m.command === it.command),
    );
    // wire 条目(TranscriptItem,role 为字符串联合)逐条断言为本地判别联合:字段名同源(host/state.ts)
    s.items = msg.messages.map((m) => ({ ...m }) as SessionItem).concat(pendingPhases);
  });
  // transcript 被整体替换（compact/branch/navigate 后）：条目树必然变化，置废下次渲染重拉
  const st = useAppStore.getState();
  if (st.rightState.entryTree?.sessionId === msg.sessionId) {
    useAppStore.setState((st2) => ({ rightState: { ...st2.rightState, entryTree: null } }));
  }
}
