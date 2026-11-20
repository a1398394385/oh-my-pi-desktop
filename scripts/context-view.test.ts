// Context viewer RPCs (host/rpc/context-view.ts): the base's /context
// projection is frozen into a snapshot on open, then list/entry read it and
// release drops it. The stub session feeds the base builder a tiny system
// prompt with one skill + one instruction-file source and a message history
// that covers every category the projection can produce.
//
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/context-view.test.ts --pool=forks --poolOptions.forks.singleFork
import { TEST_PROFILE, activeProfile } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { afterAll, test } from "bun:test";

assert.equal(activeProfile, TEST_PROFILE, "must run on the omp-desktop-test profile, never the default");

// Dynamic on purpose: host/bootstrap.ts pins its profile at module evaluation,
// so OMP_PROFILE must be set (by smoke-profile above) before these load.
const { sessions } = await import("../host/state.ts");
const { contextViewHandlers } = await import("../host/rpc/context-view.ts");
const { hostI18n } = await import("../host/i18n/host.ts");
import type { PoolEntry } from "../host/state.ts";

// Assertions read the English copy so both locale bundles are exercised by the checks below.
await hostI18n.changeLanguage("en");
afterAll(async () => {
  await hostI18n.changeLanguage("zh-CN"); // leave the shared process as found
});

const BIG = "x".repeat(25_000);
const SKILL_TEXT = "## demo skill\nUse it.";
const FILE_TEXT = '<file path="/tmp/rules.md">\nA rules\n</file>';
const BLOCK0 = `You are a test agent.\n${SKILL_TEXT}`;
const BLOCK1 = `Project context\n${FILE_TEXT}`;
const SYSTEM_PROMPT = [BLOCK0, BLOCK1];

const MESSAGES = [
  { role: "user", content: "hello viewer", timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "first plan" },
      { type: "thinking", thinking: "second plan" },
      { type: "text", text: "reading the file" },
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "/tmp/a.txt" } },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, reasoningTokens: 2 },
    stopReason: "toolUse",
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read",
    content: [{ type: "text", text: BIG }],
    isError: false,
    timestamp: 3,
  },
  {
    role: "toolResult",
    toolCallId: "call-grep",
    toolName: "grep",
    content: [{ type: "text", text: "sharedterm only here" }],
    isError: false,
    timestamp: 4,
  },
  ...Array.from({ length: 210 }, (_, index) => ({
    role: "user",
    content: index === 204 ? "Needle in a haystack" : `filler ${index}`,
    timestamp: 10 + index,
  })),
];

/** Char/4 tokenizer: the base builder only needs the counters, not real encodings. */
function stubTokenizer() {
  const count = (value: unknown): number => Math.ceil((JSON.stringify(value) ?? "").length / 4);
  return {
    countTokens: (input: string | string[]) =>
      Array.isArray(input) ? input.reduce((sum, text) => sum + count(text), 0) : count(input),
    countMessages: (messages: unknown[]) => messages.reduce((sum, message) => sum + count(message), 0),
    countMessage: count,
    countLatestTurn: count,
  };
}

/** Registry reads only: every setting falls back to its declared default. */
function stubSettings(): PoolEntry["session"]["settings"] {
  return {
    revision: 1,
    valueCache: [],
    warnState: { invalid: new Map(), items: new Map() },
    rawValue: () => undefined,
    runtimeValue: () => undefined,
    hasRuntimeOverride: () => false,
    isConfigured: () => false,
  } as unknown as PoolEntry["session"]["settings"];
}

function stubSession() {
  const tokenizer = stubTokenizer();
  return {
    sessionId: "s-context",
    agent: { tokenizer, state: { messages: MESSAGES, tools: [] }, prunesToolDescriptions: () => false },
    model: {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
      contextWindow: 200_000,
    },
    settings: stubSettings(),
    systemPrompt: SYSTEM_PROMPT,
    systemPromptSources: {
      blocks: SYSTEM_PROMPT,
      sources: [
        {
          id: "skills/0",
          kind: "skills",
          label: "demo",
          block: 0,
          start: BLOCK0.indexOf(SKILL_TEXT),
          end: BLOCK0.length,
        },
        {
          id: "instruction-files/0",
          kind: "instruction-files",
          label: "rules.md",
          path: "/tmp/rules.md",
          block: 1,
          start: BLOCK1.indexOf(FILE_TEXT),
          end: BLOCK1.length,
        },
      ],
    },
    skills: [],
    messages: MESSAGES,
    getAllToolInfos: () => [],
    hasBuiltInTool: () => false,
    getContextBreakdown: () => undefined,
  };
}

interface EntryFrame {
  id: string;
  label: string;
  tokens: number;
  preview?: string;
  childKey?: string;
  thinkingGroup?: { id: string; tokens: number };
}

interface CategoryFrame {
  id: string;
  tokens: number;
  entries: number;
  children?: Array<{ key: string; label: string; tokens: number; entries: number }>;
}

interface Frame {
  type?: string;
  reqId?: number;
  ok?: boolean;
  error?: string;
  sessionId?: string;
  snapshotId?: string;
  category?: string;
  entries?: EntryFrame[];
  total?: number;
  nextOffset?: number;
  text?: string;
  totalChars?: number;
  truncated?: boolean;
  sourceMarkers?: Array<{ start: number; end: number; category: string; entryId?: string }>;
  released?: boolean;
  categories?: CategoryFrame[];
  contextWindow?: number;
  usedTokens?: number;
  notices?: string[];
}

function channel() {
  const frames: Frame[] = [];
  return { frames, ws: { send: (data: string) => frames.push(JSON.parse(data) as Frame) } };
}

/** Run one handler call and return its (single) reply frame. */
async function call(handler: keyof typeof contextViewHandlers, msg: Record<string, unknown>): Promise<Frame> {
  const { frames, ws } = channel();
  await contextViewHandlers[handler](ws, { reqId: 7, ...msg });
  assert.equal(frames.length, 1, `${handler} 必须恰好回一帧`);
  return frames[0]!;
}

async function open(): Promise<{ index: Frame; base: Record<string, unknown> }> {
  const index = await call("context_view_open", { sessionId: "s-context" });
  assert.equal(index.ok, true, index.error);
  assert.equal(index.type, "context_view_index");
  assert.equal(index.reqId, 7);
  return { index, base: { sessionId: "s-context", snapshotId: index.snapshotId } };
}

const CATEGORY_IDS = [
  "system-prompt", "instruction-files", "skills", "built-in-tools", "custom-tools",
  "user-messages", "assistant-messages", "assistant-thinking", "tool-calls", "tool-output",
];

function category(index: Frame, id: string): CategoryFrame {
  const found = index.categories?.find((entry) => entry.id === id);
  assert(found, `缺少分类 ${id}`);
  return found!;
}

// Structural stub: buildSessionContextView reads only the AgentSession slice stubSession returns.
sessions.set("s-context", { session: stubSession() as unknown as PoolEntry["session"] } as PoolEntry);

test("open projects ten categories with non-negative weights", async () => {
  const { index } = await open();
  assert(index.snapshotId, "必须给出 snapshotId");
  assert(index.sessionId === "s-context");
  assert.deepEqual(index.categories?.map((entry) => entry.id), CATEGORY_IDS, "十类齐全且顺序稳定");
  for (const summary of index.categories ?? []) {
    assert(summary.tokens >= 0, `${summary.id} tokens 非负`);
    assert(summary.entries >= 0, `${summary.id} entries 非负`);
  }
  // Sources claimed out of the prompt become their own categories.
  assert.equal(category(index, "skills").entries, 1);
  assert.equal(category(index, "instruction-files").entries, 1);
  assert.equal(category(index, "system-prompt").entries, 2);
  assert.equal(category(index, "built-in-tools").entries, 0);
  assert.equal(category(index, "custom-tools").entries, 0);
  assert.equal(category(index, "assistant-messages").entries, 1);
  assert.equal(category(index, "tool-calls").entries, 1);
  assert.equal(category(index, "tool-output").entries, 2);
  assert.equal(category(index, "user-messages").entries, 211);
  assert.equal(category(index, "assistant-thinking").entries, 2);
  assert.equal(index.contextWindow, 200_000);
  assert(index.usedTokens! > 0);
  assert(index.notices?.some((notice) => notice.includes("estimate")), "必须声明 token 为估算值");
});

test("thinking blocks share one group weight and members carry zero", async () => {
  const { index, base } = await open();
  const thinking = category(index, "assistant-thinking");
  const page = await call("context_view_list", { ...base, category: thinking.id });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.total, 2);
  const groups = page.entries!.map((entry) => entry.thinkingGroup!);
  assert.equal(groups[0]!.id, groups[1]!.id, "同一条消息的 thinking 归入同一组");
  assert(groups[0]!.tokens > 0, "组上带共享权重");
  for (const entry of page.entries!) assert.equal(entry.tokens, 0, "成员权重为 0");
});

test("list paginates, searches case-insensitively and ignores childKey when searching", async () => {
  const { index, base } = await open();
  const first = await call("context_view_list", { ...base, category: "user-messages" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.total, 211);
  assert.equal(first.entries!.length, 200);
  assert.equal(first.nextOffset, 200);
  const second = await call("context_view_list", { ...base, category: "user-messages", offset: 200 });
  assert.equal(second.entries!.length, 11);
  assert.equal(second.nextOffset, undefined);

  const searched = await call("context_view_list", { ...base, category: "user-messages", search: "NEEDLE" });
  assert.equal(searched.total, 1, "search 大小写不敏感且跨全部条目");
  assert(searched.entries![0]!.preview?.includes("Needle"));

  const toolOutput = category(index, "tool-output");
  const children = toolOutput.children ?? [];
  assert.equal(children.length, 2, "按工具名分组");
  const readGroup = children.find((child) => child.label === "read")!;
  const grouped = await call("context_view_list", {
    ...base, category: "tool-output", childKey: readGroup.key,
  });
  assert.equal(grouped.total, 1, "childKey 只列该组条目");
  const searchedAcrossGroup = await call("context_view_list", {
    ...base, category: "tool-output", childKey: readGroup.key, search: "sharedterm",
  });
  assert.equal(searchedAcrossGroup.total, 1, "带 search 时忽略 childKey，跨整类搜索");
  assert.equal(searchedAcrossGroup.entries![0]!.label, "grep");

  const focusTarget = (await call("context_view_list", { ...base, category: "user-messages", offset: 0 })).entries;
  assert(focusTarget);
  const all = await call("context_view_list", { ...base, category: "user-messages", offset: 200 });
  const focused = await call("context_view_list", {
    ...base, category: "user-messages", focusEntryId: all.entries![5]!.id,
  });
  assert.equal(focused.nextOffset, undefined, "focus 落在最后一页");
  assert.equal(focused.entries![0]!.id, all.entries![0]!.id, "focus 所在页从页首开始");
});

test("entry pages its body and maps source markers", async () => {
  const { index, base } = await open();
  const outputs = await call("context_view_list", { ...base, category: "tool-output" });
  const read = outputs.entries!.find((entry) => entry.label === "read")!;
  assert.equal(read.childKey, category(index, "tool-output").children![0]!.key);

  const page = await call("context_view_entry", { ...base, entryId: read.id });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.type, "context_view_entry_body");
  assert.equal(page.totalChars, BIG.length);
  assert.equal(page.text!.length, 20_000);
  assert.equal(page.nextOffset, 20_000);
  assert.equal(page.truncated, false);
  const rest = await call("context_view_entry", { ...base, entryId: read.id, offset: page.nextOffset });
  assert.equal(rest.text!.length, BIG.length - 20_000);
  assert.equal(rest.nextOffset, undefined);

  const blocks = await call("context_view_list", { ...base, category: "system-prompt" });
  const withFile = blocks.entries!.find((entry) => entry.id === "system-prompt/1")!;
  const body = await call("context_view_entry", { ...base, entryId: withFile.id });
  assert.equal(body.ok, true, body.error);
  const marker = body.sourceMarkers?.[0];
  assert(marker, "system-prompt 块必须给出被拆走来源的占位标记");
  assert.equal(marker.category, "instruction-files");
  assert.equal(body.text!.slice(marker.start, marker.end).includes("Instruction Files"), true);
});

test("release drops the snapshot; stale requests fail with a correlated error", async () => {
  const { base } = await open();
  const released = await call("context_view_release", base);
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  const again = await call("context_view_release", base);
  assert.equal(again.released, false, "重复 release 幂等返回 false");

  const stale = await call("context_view_list", { ...base, category: "user-messages" });
  assert.equal(stale.ok, false);
  assert.equal(stale.type, "context_view_page");
  assert(stale.error?.includes("expired"), "过期快照必须回关联错误帧");
});

test("open on an unknown session fails instead of throwing", async () => {
  const frame = await call("context_view_open", { sessionId: "s-missing" });
  assert.equal(frame.type, "context_view_index");
  assert.equal(frame.ok, false);
  assert(frame.error?.includes("s-missing"));
});
