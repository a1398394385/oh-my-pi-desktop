// Throwaway probe: the live-refresh half of the SessionStatsBar fix, driven
// through the REAL host with a stubbed session (no model/API key needed).
//
// Verifies: session_stats frames now arrive on message_end / tool_execution_end,
// i.e. before the terminal agent_end push, and that repeated tool events are
// throttled instead of flooding the wire.
//
// Run: OMP_PROFILE=omp-desktop-test bun scripts/probe-stats-live-push.ts
import { attachEntry } from "../host/session-lifecycle.ts";
import type { PoolEntry } from "../host/state.ts";

type Listener = (ev: Record<string, unknown>) => void;

const frames: Array<{ type: string; at: number; input: number }> = [];
const sent: string[] = [];
const ws = {
  send(raw: string) {
    sent.push(raw);
    const msg = JSON.parse(raw);
    if (msg.type === "session_stats") frames.push({ type: msg.kind ?? "stats", at: Date.now(), input: msg.tokens.input });
  },
};

// Minimal PoolEntry stand-in: attachEntry only needs subscribe + the fields the
// event handler touches. attachEntry subscribes twice on the session (main event
// pipeline + subagent forwarding), so the stub must retain every listener.
const listeners: Listener[] = [];
const entry = {
  session: {
    subscribe(fn: Listener) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getTodoPhases: () => [],
    getContextUsage: () => undefined,
    getAdvisorCost: () => 0,
    prompt: async () => {},
    agent: {
      peekFollowUpQueue: () => [],
      peekSteeringQueue: () => [],
      addBeforeQueuedMessageDequeueHook: () => {},
      followUp: () => {},
      continue: async () => {},
    },
    extensionRunner: undefined,
    sessionManager: { appendCustomEntry() {}, appendLabelChange() {} },
    getEnabledToolNames: () => [],
    getAllToolInfos: () => [],
    sendCustomMessage: async () => {},
    sendUserMessage: async () => {},
  },
  sessionResult: { setToolUIContext() {} },
  manager: {
    getUsageStatistics: () => ({ input: 1234, output: 56, cacheRead: 78, cacheWrite: 0, cost: 0.01 }),
    getEntries: () => [],
  },
  transcript: [],
  assistantDraft: "",
  thinkingDraft: "",
  thinkingStartedAt: null,
  activeMs: 1000,
  activeStartedAt: null,
  statsPushedAt: null,
  path: "/tmp/probe.jsonl",
  cwd: "/tmp",
  isGit: false,
  queuedTexts: [],
  consumedTexts: [],
  parkedFollowUp: [],
  mentionScanIndex: 0,
  keepaliveWanted: false,
  goal: { onAgentStart() {}, onUserMessage() {}, onGoalUpdated() {}, onAgentEnd() {} },
  externalWrite: false,
  entryTreeNav: false,
  providerSessionId: "",
  pollKnownSize: 0,
  sessionId: "sess-probe",
  model: null,
  thinking: "auto",
  planMode: false,
  todos: [],
} as unknown as PoolEntry;

const eventBus = { on() { return () => {}; } };
attachEntry(ws as never, "sess-probe", entry, eventBus as never);
if (listeners.length === 0) throw new Error("subscribe never fired");

const emit = (ev: Record<string, unknown>) => {
  for (const fn of listeners) fn(ev);
};

// 1) agent_start: opens the active-time window, no stats push expected
emit({ type: "agent_start" });
const afterStart = frames.length;

// 2) first message_end: must push immediately (numbers start moving)
emit({ type: "message_end", message: { role: "assistant" } });
const afterFirst = frames.length;

// 3) a burst of tool_execution_end within the throttle window: coalesced
for (let i = 0; i < 20; i++) emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t" + i, result: {} });
const afterBurst = frames.length;

// 4) after the throttle interval elapses, the next event pushes again
const cooldown = Promise.withResolvers<void>();
setTimeout(() => cooldown.resolve(), 1600);
await cooldown.promise;
emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "late", result: {} });
const afterCooldown = frames.length;

// 5) terminal agent_end still pushes the final numbers
emit({ type: "agent_end", isTerminal: true, messages: [] });
const afterEnd = frames.length;

console.log("session_stats 帧数：");
console.log("  agent_start 后:", afterStart, "(期望 0 —— 还没开始消耗)");
console.log("  首个 message_end 后:", afterFirst, "(期望 1 —— 立刻推，turn 一开始数字就动)");
console.log("  20 次 tool_execution_end 突发后:", afterBurst, "(期望仍为 1 —— 节流生效)");
console.log("  超过节流间隔后再来一次:", afterCooldown, "(期望 2)");
console.log("  agent_end 后:", afterEnd, "(期望 3 —— 收尾照推最终值)");

const payload = JSON.parse(sent.find((s) => s.includes("session_stats"))!);
console.log("\npayload.tokens:", payload.tokens, "(来自 manager.getUsageStatistics 累计口径)");
console.log("payload.cacheHitRate:", payload.cacheHitRate);
console.log("payload.activeMs:", payload.activeMs, "(activeMs 1000 + 进行中窗口)");

const ok = afterStart === 0 && afterFirst === 1 && afterBurst === 1 && afterCooldown === 2 && afterEnd === 3;
console.log("\n" + (ok ? "✓ 实时推送 + 节流 全部符合预期" : "✗ 不符合预期"));
process.exit(ok ? 0 : 1);
