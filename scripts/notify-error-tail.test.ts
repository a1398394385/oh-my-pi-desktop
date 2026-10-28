// Desktop alert gating: a provider failure the base auto-retried must stay silent (the run
// keeps going), only a failure the run actually ended on alerts. Drives the real
// applyEvent path with a captured send_desktop_notification.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/notify-error-tail.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import type { OpenSession, SessionItem } from "../ui-src/types/session";
import type { SettingsPayload } from "../ui-src/types/frames";

const sent: { title: string; body: string; path?: string }[] = [];
// ws.ts binds `invoke` from window.__TAURI__ at module scope — install the stub first,
// then load the store graph (dynamic imports, same reason as smoke-dual-channel-store.ts).
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: {
    invoke: async (cmd: string, args: { title: string; body: string; path?: string }) => {
      if (cmd === "send_desktop_notification") sent.push(args);
    },
  },
};
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session");

function seed(id: string, items: SessionItem[]): void {
  sent.length = 0;
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
  // Only the two fields notifyDesktop reads matter; the rest of the settings/uiPrefs breadths
  // are irrelevant here.
  const hostSettings = { values: { "error.notify": "on" } } as unknown as SettingsPayload;
  useAppStore.setState({
    ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    diskProjects: [],
    hostSettings,
    uiPrefs: { ...useAppStore.getState().uiPrefs, notifyDesktop: true, notifySound: false },
  });
  useAppStore.setState((st) => ({ openSessions: new Map(st.openSessions).set(`/tmp/${id}.jsonl`, s), activePath: "/tmp/other.jsonl" }));
}

const event = (sessionId: string, kind: string, extra: Record<string, unknown> = {}): void =>
  applyEvent({ sessionId, kind, ...extra } as never);

describe("desktop alert on a failed run", () => {
  test("a retried failure stays silent and does not swallow the finished alert", () => {
    seed("retried", [{ role: "user", text: "go" }]);
    event("retried", "error", { text: "400 invalid request" });
    expect(sent).toHaveLength(0);
    // the base retried and the run kept producing output
    event("retried", "text_delta", { text: "recovered answer" });
    event("retried", "turn_end", { runEnd: true, usage: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("recovered answer");
    expect(sent[0].path).toBe("/tmp/retried.jsonl");
  });

  test("a failure the run ended on alerts with the error text", () => {
    seed("aborted", [{ role: "user", text: "go" }]);
    event("aborted", "error", { text: "retry budget exhausted: 400 invalid request" });
    event("aborted", "turn_end", { runEnd: true, usage: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("retry budget exhausted: 400 invalid request");
  });
});
