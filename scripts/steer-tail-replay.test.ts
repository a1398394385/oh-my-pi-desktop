// Steer-at-run-tail store replay: drives the real zustand store with the frame
// sequences observed in the wild (scripts/steer-tail-smoke.ts) and asserts the
// steer bubble's fate. Regression for the bug where the bubble vanished after
// the run ended (the A14 sink dropped the streaming branch's prompt RPC, and a
// degenerated steer that raced the run's end never got a steer_consumed).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/steer-tail-replay.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { sendComposerPrompt } from "../ui-src/components/composer/send";
import type { OpenSession } from "../ui-src/types/session";

const SID = "replay-1";
const PATH = "/tmp/replay/session-a.jsonl";

function seedSession(streaming: boolean): OpenSession {
  const s: OpenSession = {
    sessionId: SID,
    path: PATH,
    items: [{ role: "user", text: "写一篇关于灯塔的短文" }],
    assistantDraft: "",
    streaming,
    turnItemStart: streaming ? 1 : null,
    turnStartAt: streaming ? Date.now() : null,
    workingText: null,
  } as unknown as OpenSession;
  useAppStore.setState({ ws: { readyState: 1, send: () => {} } as unknown as WebSocket });
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(PATH, s), activePath: PATH }));
  return s;
}

function event(kind: string, extra: Record<string, unknown> = {}): void {
  // Frame dispatch goes through the stamped-event admission only on the ws
  // path; applyEvent is the store's direct entry and needs no hi/seq
  const { applyEvent } = require("../ui-src/store/session");
  applyEvent({ sessionId: SID, kind, ...extra } as never);
}

function items(): ReturnType<typeof useAppStore.getState>["openSessions"] {
  return useAppStore.getState().openSessions;
}

const sent: unknown[] = [];
describe("steer at the run tail", () => {
  test("mid-stream steer dispatches a prompt RPC with the steer flag (A14 regression)", () => {
    sent.length = 0;
    seedSession(true);
    // Swap the ws writer for a capture stub for the composer path
    const st = useAppStore.getState();
    const prevSend = st.send;
    st.send = (msg: unknown) => sent.push(msg);
    const ok = sendComposerPrompt({ raw: "补充：末尾输出 PONG", files: [], steer: true });
    st.send = prevSend;
    expect(ok).toBe(true);
    const bubble = items().get(PATH)!.items.find((i) => i.role === "user" && "pending" in i && i.pending);
    expect(bubble).toBeTruthy(); // optimistic pending bubble pushed
    const rpc = sent.find((m) => (m as { type?: string }).type === "prompt") as { steer?: boolean; text?: string } | undefined;
    expect(rpc?.steer).toBe(true); // the dropped dispatch is back
    expect(rpc?.text).toContain("PONG");
  });

  test("degenerated steer (raced the run end) is rescued at the fresh turn_start", () => {
    seedSession(true);
    const st = useAppStore.getState();
    const prevSend = st.send;
    st.send = () => {};
    sendComposerPrompt({ raw: "补充：末尾输出 PONG", files: [], steer: true });
    st.send = prevSend;
    // Old run ends first: the seal folds the pending bubble into a collapsed loop group
    event("text_delta", { text: "灯塔短文正文……" });
    event("turn_end", { runEnd: true, usage: null });
    let s = items().get(PATH)!;
    expect(s.streaming).toBe(false);
    const group = s.items.find((i) => i.role === "loop");
    expect(group).toBeTruthy(); // sealed into the loop group (the vanishing spot)
    expect((group as { items?: Array<{ role?: string; pending?: string | null }> }).items?.some((k) => k.pending)).toBe(true);
    // The degenerated steer opens a plain new run: turn_start with no steer_consumed
    event("turn_start");
    s = items().get(PATH)!;
    const rescued = s.items.filter((i) => i.role === "user" && (i as { pending?: string | null }).pending === null && (i as { steerDone?: boolean }).steerDone);
    expect(rescued.some((i) => (i as { text?: string }).text?.includes("PONG"))).toBe(true); // bubble promoted, visible at top level
    expect(s.items.some((i) => i.role === "loop")).toBe(false); // empty group removed
    expect(s.turnItemStart).toBe(s.items.length); // process starts after the rescued bubble
  });

  test("normal consumption path unaffected (steer_consumed promotes before turn_start)", () => {
    seedSession(true);
    const st = useAppStore.getState();
    const prevSend = st.send;
    st.send = () => {};
    sendComposerPrompt({ raw: "补充：末尾输出 PONG", files: [], steer: true });
    st.send = prevSend;
    const { applySteerConsumed } = require("../ui-src/store/session");
    applySteerConsumed({ sessionId: SID, texts: ["补充：末尾输出 PONG"] });
    event("turn_start");
    const s = items().get(PATH)!;
    const promoted = s.items.find((i) => i.role === "user" && (i as { steerDone?: boolean }).steerDone);
  });
});
