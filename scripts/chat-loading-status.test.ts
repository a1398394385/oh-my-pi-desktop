// Streaming status row: the glyph follows the live activity (thinking → think, running tool →
// that tool's own icon) and a thinking block streams only its tail next to the label.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/chat-loading-status.test.ts --pool=forks --poolOptions.forks.singleFork
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../ui-src/types/session";

// ws.ts binds invoke from window.__TAURI__ at module scope, so the stub must exist before the
// store graph loads — hence the dynamic imports below (same shape as session-notice-render.test.ts).
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke: async () => {} },
};
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { liveActivity, thoughtTail } = await import("../ui-src/components/chat/ChatLoading");

function think(thinking: string, streaming: boolean): ChatItem {
  return { role: "thinking", text: "思考", thinking, streaming };
}

describe("liveActivity", () => {
  test("streaming thinking wins with the think glyph", () => {
    expect(liveActivity([think("hmm", true)])).toEqual({ icon: "think", thinking: "hmm" });
  });

  test("a finished thought hands the glyph to the running tool", () => {
    const items: ChatItem[] = [think("done", false), { role: "tool", text: "read", name: "read", running: true }];
    expect(liveActivity(items).icon).toBe("read");
  });

  test("a settled tool does not keep its glyph", () => {
    const items: ChatItem[] = [{ role: "tool", text: "bash", name: "bash", running: false }];
    expect(liveActivity(items).icon).toBe("think");
  });
});

describe("thoughtTail", () => {
  test("keeps the newest words, collapses whitespace, caps the length", () => {
    const head = "头".repeat(300);
    const tail = thoughtTail(`${head}\n  最末尾\n的想法 `);
    expect(tail).toContain("最末尾 的想法");
    expect(tail).not.toContain(head);
    expect(tail.length).toBe(160);
  });

  test("empty thinking renders nothing", () => {
    expect(thoughtTail("   ")).toBe("");
  });
});
