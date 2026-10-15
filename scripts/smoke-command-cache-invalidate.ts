// Store-level smoke: an agent_assets frame must drop the composer's cached
// command list so the next $ // / completion refetches (skill toggles land as
// agent_assets; the cache key alone would keep serving the stale list).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-command-cache-invalidate.ts
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.navigator = window.navigator;
globalThis.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.matchMedia = (q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.location = window.location;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

const { useAppStore } = await import("../ui-src/store/index.ts");
const { dispatchFrame } = await import("../ui-src/store/wsHandlers/index.ts");

// 1. Seed the composer cache the way a real list_commands reply does
dispatchFrame({
  type: "commands",
  commands: [{ name: "skill:stale-skill", description: "", hint: null, source: "skill", aliases: [], subcommands: [] }],
  sessionId: null as never,
} as never);
{
  const st = useAppStore.getState();
  if (st.commands === null || !st.commands.some((c: { name: string }) => c.name === "skill:stale-skill")) {
    console.error("FAIL: commands frame did not seed the cache");
    process.exit(1);
  }
  if (st.commandsSessionId !== "new") {
    console.error("FAIL: commandsSessionId expected 'new', got", st.commandsSessionId);
    process.exit(1);
  }
}
console.log("✓ commands 帧已缓存列表");

// 2. An agent_assets frame (skill toggle) must invalidate the cache
dispatchFrame({ type: "agent_assets", assets: { skills: {} } } as never);
{
  const st = useAppStore.getState();
  if (st.commands !== null || st.commandsSessionId !== null) {
    console.error(`FAIL: agent_assets did not invalidate (commands=${st.commands === null ? "null" : "stale"}, key=${st.commandsSessionId})`);
    process.exit(1);
  }
}
console.log("✓ agent_assets 帧已失效命令缓存");

console.log("✓ 命令缓存失效冒烟通过");
process.exit(0);
