// Mid-run attach fold replay: a UI that attaches while a run is in progress (remote
// join, desktop reopen) missed the run's first turn_start; the first one it sees is a
// tool-loop continuation's. Regression for the fold boundary landing at the attach
// moment: the pre-attach half of the run stayed flat while the watched half collapsed
// into a loop group, instead of the whole run sealing into one group like the reload
// path (host/translate-history.ts).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/midrun-attach-fold.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { initI18n } from "../ui-src/i18n";
import { useAppStore } from "../ui-src/store";
import type { LoopItem, OpenSession, SessionItem } from "../ui-src/types/session";

initI18n("zh-CN"); // session.ts builds the desktop-alert body via t() at turn_end

const SID = "attach-1";
const PATH = "/tmp/attach/session-a.jsonl";

function seedSession(items: SessionItem[]): OpenSession {
  const s: OpenSession = {
    sessionId: SID,
    path: PATH,
    items,
    assistantDraft: "",
    streaming: true,
    turnItemStart: null, // attached mid-run: the run's first turn_start was missed
    turnStartAt: Date.now(),
    workingText: null,
  } as unknown as OpenSession;
  useAppStore.setState({ ws: { readyState: 1, send: () => {} } as unknown as WebSocket });
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH }));
  return s;
}

function event(kind: string, extra: Record<string, unknown> = {}): void {
  const { applyEvent } = require("../ui-src/store/session");
  applyEvent({ sessionId: SID, kind, ...extra } as never);
}

function sess(): OpenSession {
  return useAppStore.getState().openSessions.get(PATH)!;
}

describe("mid-run attach fold boundary", () => {
  test("continuation turn_start anchors at the turn's user message, not the attach moment", () => {
    seedSession([
      { role: "user", text: "查证一下" },
      { role: "thinking", text: "hmm" },
      { role: "tool", text: "bash", name: "bash" },
    ]);
    event("turn_start"); // first frame of this UI: a tool-loop continuation's
    expect(sess().turnItemStart).toBe(1);
  });

  test("run end seals the whole turn (pre- and post-attach) into one flat group", () => {
    seedSession([
      { role: "user", text: "查证一下" },
      { role: "thinking", text: "hmm" },
      { role: "tool", text: "bash", name: "bash" },
    ]);
    event("turn_start");
    event("tool", { name: "read", toolCallId: "c1", args: { path: "/x" } });
    event("text_delta", { text: "结论：钩子能力更多" });
    event("turn_end", { runEnd: true, usage: null });
    const s = sess();
    expect(s.streaming).toBe(false);
    expect(s.items.map((it) => it.role)).toEqual(["user", "loop", "assistant"]);
    const group = s.items[1] as LoopItem;
    expect(group.items!.map((it) => it.role)).toEqual(["thinking", "tool", "tool"]);
  });

  test("a partial-turn loop group from a mid-run transcript rebuild un-nests at the seal", () => {
    seedSession([
      { role: "user", text: "查证一下" },
      { role: "loop", text: "", collapsed: true, items: [{ role: "thinking", text: "hmm" } as SessionItem] } as SessionItem,
      { role: "tool", text: "bash", name: "bash" },
    ]);
    event("turn_start");
    event("turn_end", { runEnd: true, usage: null });
    expect(sess().items.map((it) => it.role)).toEqual(["user", "loop"]);
    const group = sess().items[1] as LoopItem;
    expect(group.items!.map((it) => it.role)).toEqual(["thinking", "tool"]);
  });
});
