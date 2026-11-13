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
const { liveActivity, thoughtWindow } = await import("../ui-src/components/chat/ChatLoading");

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

  test("a settled tool keeps its glyph while the run generates the reply", () => {
    const items: ChatItem[] = [{ role: "tool", text: "bash", name: "bash", running: false }];
    expect(liveActivity(items).icon).toBe("termBox");
  });

  test("the newest settled tool names the activity before an older one", () => {
    const items: ChatItem[] = [
      { role: "tool", text: "read", name: "read", running: false },
      { role: "tool", text: "bash", name: "bash", running: false },
    ];
    expect(liveActivity(items).icon).toBe("termBox");
  });
});

describe("thoughtWindow", () => {
  test("keeps the newest words of the painted prefix, collapses whitespace, caps the length", () => {
    const head = "头".repeat(300);
    const thought = `${head}\n  最末尾\n的想法 `;
    const tail = thoughtWindow(thought, thought.length);
    expect(tail).toContain("最末尾 的想法");
    expect(tail).not.toContain(head);
    expect(tail.length).toBeLessThanOrEqual(160);
  });

  test("paints only the prefix the progress has reached", () => {
    expect(thoughtWindow("一二三四五六", 2)).toBe("一二");
    expect(thoughtWindow("   ", 3)).toBe(" ");
  });
});
