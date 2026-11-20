// Streaming status row: the glyph follows the live activity (thinking → think, running tool →
// that tool's own icon) and a thinking block streams only its tail next to the label.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/chat-loading-status.test.ts --pool=forks --poolOptions.forks.singleFork
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../ui-src/types/session";

// ws.ts binds invoke from window.__TAURI__ at module scope; the shared dom-stub installs
// that stub process-wide (a file-local one would only win when this file happens to load
// the store graph first) — hence the dynamic imports below.
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

  test("the reply's own text streaming supersedes the last tool's glyph", () => {
    const items: ChatItem[] = [{ role: "tool", text: "bash", name: "bash", running: false }];
    expect(liveActivity(items, true)).toEqual({ icon: "writing" });
    expect(liveActivity([think("hmm", true)], true).icon).toBe("writing");
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

  test("a line that filled the row restarts at the reset offset", () => {
    expect(thoughtWindow("一二三四五六", 5, 3)).toBe("四五");
  });
});
