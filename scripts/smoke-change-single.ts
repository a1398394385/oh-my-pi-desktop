// Multi-file single edit event (one apply_patch touching several files) row smoke:
// the row shows the line counts and expands into one diff per file. Both hang off
// the same item (details.perFileResults), unlike the change group where each row is
// its own event.
// Run: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-change-single.ts
//
// Store / i18n / renderChange are dynamic imports ON PURPOSE (same reason as
// smoke-ask-approval.ts): their module top levels touch window/document, which must be
// the happy-dom globals installed below before evaluation.
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {};
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
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
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.MutationObserver = window.MutationObserver;

document.body.innerHTML = '<div id="host"></div>';

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../ui-src/store");
const { renderChange } = await import("../ui-src/components/chat/EditRow");
import type { ToolItem } from "../ui-src/types/session";

// ---- Seed: one multi-file event; counts come from the host's per-file diff sum ----
const sent: { type: string; path?: string }[] = [];
const item: ToolItem = {
  role: "tool",
  name: "edit",
  toolCallId: "call_multi",
  text: "",
  args: { input: "patch" },
  files: ["src/a.ts", "src/b.ts", "src/c.ts"],
  added: 3,
  removed: 3,
  details: {
    perFileResults: [
      { path: "src/a.ts", diff: "@@ -1,1 +1,2 @@\n a\n+b" },
      { path: "src/b.ts", diff: "@@ -1,2 +1,2 @@\n-a\n+A\n b" },
      { path: "src/c.ts", diff: "@@ -1,2 +1,1 @@\n-c\n-d\n+C" },
    ],
  },
};
useAppStore.setState({
  activePath: "/p/s1",
  openSessions: new Map([
    [
      "/p/s1",
      {
        sessionId: "s1",
        cwd: "/p",
        items: [item],
        assistantDraft: "",
        streaming: false,
        subagents: new Map(),
        model: "m",
        thinking: "off",
        isGit: false,
        todos: [],
      },
    ],
  ]),
  ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
});

// Re-render on the store's item swap: clicking patches a copy into the transcript
const Row = () => {
  const it = useAppStore((s) => s.openSessions.get("/p/s1")?.items[0]) as ToolItem;
  return renderChange(it);
};
const root = createRoot(document.getElementById("host")!);
root.render(React.createElement(Row));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error("assertion failed: " + label);
};

await sleep(100);

// ---- Collapsed: label + file chips + counts + arrow, no body ----
const row = document.querySelector(".act.change");
ok(row !== null, "multi-file event renders the change row");
ok((row?.querySelector(".lbl")?.textContent ?? "").includes("3"), "row labels the file count");
ok(row?.querySelectorAll(".f-ic").length === 3, "row lists one chip per file");
ok((row?.querySelector(".add")?.textContent ?? "") === "+3", "row shows the added line count");
ok((row?.querySelector(".del")?.textContent ?? "") === "−3", "row shows the removed line count");
ok(row?.querySelector(".ed-arrow") !== null, "row carries the expand arrow");
ok(document.querySelector(".chg-body") === null, "row starts collapsed");
// Per-file diffs ride the item, so expanding must not hit the host
ok(sent.length === 0, "no diff request before expanding");

// ---- Expanded: one section per file, each with its own diff ----
row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(100);
const body = document.querySelector(".chg-body");
ok(body !== null, "clicking the row expands the body");
ok(body?.querySelectorAll(".chg-item").length === 3, "body carries one header per file");
ok(body?.querySelectorAll(".ed-brief").length === 3, "body carries one diff per file");
const texts = [...(body?.querySelectorAll(".ed-brief") ?? [])].map((el) => el.textContent ?? "");
ok(texts[0]?.includes("b") && !texts[0]?.includes("A"), "first brief renders its own file's diff");
ok(texts[1]?.includes("A"), "second brief renders its own file's diff");
ok(texts[2]?.includes("C"), "third brief renders its own file's diff");
ok(sent.length === 0, "per-file diffs need no git diff request");

// ---- Collapse writes the flag back and unmounts the body ----
row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(300); // the collapse animation commits after ~210ms
ok(document.querySelector(".chg-body") === null, "second click collapses the body");

root.unmount();
console.log("smoke-change-single: all assertions passed");
process.exit(0);
