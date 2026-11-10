// Extension-rendering store branches: base UI-only notices land as the session-scoped strip,
// a renderer's whole-block output replaces the draft, and ctx.ui.rerenderMessage replaces the
// row it addresses. These three frames are the only path by which the new host behavior
// (tools.xdevNotices, extensionRenderers.assistantText) reaches the screen.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/session-notice-render.test.ts --pool=forks --poolOptions.forks.singleFork
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import type { OpenSession, SessionItem } from "../ui-src/types/session";

// ws.ts binds `invoke` from window.__TAURI__ at module scope — install the stub before loading
// the store graph (same as notify-error-tail.test.ts).
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke: async () => {} },
};
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");

function seed(id: string, items: SessionItem[]): void {
  const s = {
    sessionId: id,
    items,
    assistantDraft: "",
    streaming: true,
    turnItemStart: 1,
    turnStartAt: Date.now(),
    workingText: null,
    isGit: false,
    subagents: new Map(),
  } as unknown as OpenSession;
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    diskProjects: [],
  });
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(`/tmp/${id}.jsonl`, s), activePath: "/tmp/other.jsonl" }));
}

const session = (id: string): OpenSession => useAppStore.getState().openSessions.get(`/tmp/${id}.jsonl`)!;
const event = (sessionId: string, kind: string, extra: Record<string, unknown> = {}): void =>
  applyEvent({ sessionId, kind, ...extra } as never);

describe("extension rendering frames", () => {
  test("a base notice becomes the session-scoped strip and is not a transcript row", () => {
    seed("notice", [{ role: "user", text: "go" }]);
    event("notice", "notice", { level: "warning", message: "xd:// mounted", source: "xd" });
    expect(session("notice").notice).toEqual({ level: "warning", message: "xd:// mounted", seq: expect.any(Number) });
    expect(session("notice").items).toHaveLength(1);
  });

  test("a renderer reset replaces the draft instead of appending to it", () => {
    seed("reset", []);
    event("reset", "text_delta", { text: "raw te" });
    event("reset", "text_delta", { text: "rendered text", reset: true });
    expect(session("reset").assistantDraft).toBe("rendered text");
  });

  test("a prediction frame offers choices, an empty one retires them, a turn clears them", () => {
    seed("pred", []);
    event("pred", "prediction", { choices: ["run the tests", "ship it"] });
    expect(session("pred").prediction).toEqual(["run the tests", "ship it"]);
    event("pred", "prediction", { choices: [] });
    expect(session("pred").prediction).toBeNull();
    event("pred", "prediction", { choices: ["one", "two"] });
    event("pred", "turn_start", {});
    expect(session("pred").prediction).toBeNull();
    expect(session("pred").predictionOpen).toBe(false);
  });

  test("a rerender frame replaces the addressed row only", () => {
    seed("rerender", [
      { role: "assistant", text: "first block", ts: 111, block: 0 },
      { role: "assistant", text: "second block", ts: 111, block: 2 },
    ]);
    event("rerender", "assistant_rerender", { ts: 111, block: 2, text: "redrawn block" });
    const items = session("rerender").items as Array<{ text: string }>;
    expect(items[0]!.text).toBe("first block");
    expect(items[1]!.text).toBe("redrawn block");
  });
});
