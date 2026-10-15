// Throwaway smoke: pg-shell placement + interceptor graphical editor (ShellPage.tsx).
// Renders the real page against a fabricated schema/settings snapshot, then walks the
// edit / add / validate / reorder paths and asserts outbound set_setting frames.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-shell-page.tsx
// Dynamic imports: UI modules read DOM globals at import time, so the smoke window and
// the mock WebSocket must be installed before they load (same shape as smoke-ui-send.ts).
import { Window } from "happy-dom";
import { strict as assert } from "node:assert";

const win = new Window({ url: "http://localhost/?preview=1" });
if (process.env.OMP_PROFILE !== "omp-desktop-test") throw new Error("UI 冒烟必须使用 OMP_PROFILE=omp-desktop-test");
Object.assign(globalThis, {
  window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator,
  location: win.location, Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
  DocumentFragment: win.DocumentFragment, Text: win.Text, Selection: win.Selection, Range: win.Range,
  // Radix primitives (Switch) reference these globals at mount time
  HTMLFormElement: win.HTMLFormElement, HTMLInputElement: win.HTMLInputElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
  FormData: win.FormData, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---- mock WebSocket: capture every frame the UI sends ----
const sent: Array<Record<string, any>> = [];
class MockWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
(win as unknown as Record<string, unknown>).__TAURI__ = {
  core: { invoke: async (cmd: string) => (cmd === "ws_url" ? "ws://mock-host" : null) },
};

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { default: ShellPage } = await import("../ui-src/components/settings/pages/ShellPage");
const { buildKeyToPageMap } = await import("../ui-src/components/settings/placement");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const def = (type: string, ui?: Record<string, unknown>) => ({ type, ...(ui ? { ui } : {}) }) as never;
const bashUi = { tab: "shell", group: "Bash" };
const schema = {
  "bash.enabled": def("boolean", { ...bashUi, label: "Bash" }),
  "bash.allowCompoundCommands": def("boolean", { ...bashUi, label: "Allow Compound Commands" }),
  "bash.patterns": def("array", { ...bashUi, label: "Bash Approval Patterns" }),
  "bashInterceptor.enabled": def("boolean", { ...bashUi, label: "Bash Interceptor" }),
  "bashInterceptor.patterns": def("array"),
  "bash.direnv": def("enum", { ...bashUi, label: "direnv Auto-Load" }),
  "bash.direnvLoadTimeoutMs": def("number", { ...bashUi, label: "direnv Load Timeout (ms)" }),
  "shellMinimizer.enabled": def("boolean", { ...bashUi, label: "Shell Minimizer" }),
  "shellMinimizer.sourceOutlineLevel": def("enum", { ...bashUi, label: "Shell Minimizer Source Outline" }),
  "shellMinimizer.settingsPath": def("string"),
  "shellMinimizer.only": def("array"),
  "shellMinimizer.except": def("array"),
  "shellMinimizer.maxCaptureBytes": def("number"),
  "shellMinimizer.legacyFilters": def("boolean"),
  "bash.autoBackground.thresholdMs": def("number"),
  "eval.autoBackground.thresholdMs": def("number"),
  "eval.py": def("boolean", { tab: "shell", group: "Eval & Runtimes", label: "Eval Python" }),
  "eval.js": def("boolean", { tab: "shell", group: "Eval & Runtimes", label: "Eval JS" }),
};
const rules = [
  { pattern: "^\\s*(cat|head|tail|less|more)\\s+", tool: "read", message: "Use the `read` tool instead." },
  { pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+", tool: "grep", message: "Use the `grep` tool instead." },
  { pattern: "^\\s*sed\\s+(-i|--in-place)", flags: "i", tool: "edit", message: "Use the `edit` tool instead.", allowSubcommands: ["-e"] },
];

// Host settings frame routed through the real ws handler (settings → hostSettings)
const mockWsInstance = { onmessage: null as null | ((ev: { data: string }) => void) };
await useAppStore.getState().connect();
// connect() constructed our MockWebSocket; find it by re-reading the store's ws
const ws = useAppStore.getState().ws as unknown as { onmessage: ((ev: { data: string }) => void) | null };
void mockWsInstance;
const hostFrame = (frame: Record<string, unknown>) => ws.onmessage!({ data: JSON.stringify(frame) });

useAppStore.setState({ settingsSchema: schema as never });
hostFrame({
  type: "settings",
  settings: {
    hideThinkingBlock: false, computerEnabled: false, approvalMode: "write", activeProfile: "default",
    profileAgentDir: "/d", conditions: {},
    values: {
      "bashInterceptor.enabled": true, "bashInterceptor.patterns": rules,
      "shellMinimizer.enabled": true, "shellMinimizer.legacyFilters": true,
    },
  },
});
useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, lang: "zh-CN" } }));

// Placement: interceptor/minimizer keys map to pg-shell (advanced page releases them)
const map = buildKeyToPageMap(schema as never);
for (const k of ["bashInterceptor.enabled", "bashInterceptor.patterns", "shellMinimizer.enabled", "shellMinimizer.only", "shellMinimizer.except", "shellMinimizer.maxCaptureBytes", "shellMinimizer.settingsPath", "shellMinimizer.legacyFilters"]) {
  assert.equal(map[k], "pg-shell", k + " should map to pg-shell, got " + map[k]);
}

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const rulesSent = () => sent.filter((m) => m.type === "set_setting" && m.key === "bashInterceptor.patterns");

try {
  await act(async () => root.render(createElement(ShellPage)));

  // 1. Page composition: Bash / interceptor / minimizer / eval groups; ui-less threshold
  // keys merged into their ui groups' cards, each key rendered exactly once
  assert.equal(host.querySelector("#pg-shell .set-tt")!.textContent, "Shell");
  const titles = [...host.querySelectorAll(".set-group-tt")].map((e) => e.textContent);
  assert.deepEqual(titles, ["Bash", "Shell 拦截器", "Shell 精简器", "求值与运行时"], "group titles: " + JSON.stringify(titles));
  const keys = [...host.querySelectorAll(".srow[data-key]")].map((e) => e.getAttribute("data-key"));
  assert.equal(keys.filter((k) => k === "bashInterceptor.enabled").length, 1, "enabled renders exactly once");
  assert.equal(keys.filter((k) => k === "shellMinimizer.enabled").length, 1);
  assert(keys.includes("shellMinimizer.legacyFilters"), "ui-less minimizer key renders on pg-shell");
  assert(keys.includes("bash.autoBackground.thresholdMs"), "bash threshold merged into the Bash card");
  assert(keys.includes("eval.autoBackground.thresholdMs"), "eval threshold merged into the eval card");
  assert.equal(keys.filter((k) => k?.endsWith("autoBackground.thresholdMs")).length, 2, "threshold keys render exactly once each");

  // 2. Rules list: 3 rows, tool tags, flags suffix on the third, count tag, search anchor
  const rows = [...host.querySelectorAll(".itcp-row")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector(".tag")!.textContent, "read");
  assert.equal(rows[2].querySelector(".itcp-flags")!.textContent, "/i");
  assert(host.querySelector(".itcp-head[data-key='bashInterceptor.patterns']"), "search-flash anchor row present");
  assert(host.querySelector(".itcp-head .tag")!.textContent!.includes("3"));

  // 3. Expand → edit pattern → save: merged rule sent, unknown field preserved
  await click(rows[2]);
  let editor = host.querySelector(".mem-expand")!;
  const fieldVals = () => {
    const els = [...editor.querySelectorAll("input, textarea")] as HTMLInputElement[];
    const set = (el: HTMLInputElement, v: string) => {
      Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")!.set!.call(el, v);
      // React internal: the value tracker misses prototype-level sets, so onChange
      // would see "no change" — clear it via the well-known _valueTracker field
      const tracker = (el as unknown as Record<string, unknown>)._valueTracker as
        | { setValue(v: string): void }
        | undefined;
      tracker?.setValue("");
      el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    };
    return { els, set };
  };
  const save = async () => {
    await act(async () => [...editor.querySelectorAll("button")].find((b) => b.textContent === "保存")!.click());
  };
  let f = fieldVals();
  await act(async () => f.set(f.els.find((i) => i.value.startsWith("^\\s*sed"))!, "^\\s*sed\\s+(-i)"));
  await save();
  const sent1 = rulesSent().at(-1)!.value as Array<Record<string, unknown>>;
  assert.equal(sent1[2].pattern, "^\\s*sed\\s+(-i)");
  assert.deepEqual(sent1[2].allowSubcommands, ["-e"], "unknown field preserved through graphical edit");
  assert.equal(host.querySelector(".mem-expand"), null, "editor closes after save");

  // 4. Add: new editor under the head, rule appended last, empty flags dropped
  await click(host.querySelector(".itcp-head .add-btn")!);
  editor = host.querySelector(".mem-expand")!;
  f = fieldVals();
  await act(async () => f.set(f.els[0], "^\\s*ls\\s+"));
  await act(async () => f.set(f.els[1], "glob"));
  await act(async () => f.set(f.els[2], "Use glob."));
  await save();
  const sentAdd = rulesSent().at(-1)!.value as Array<Record<string, unknown>>;
  assert.equal(sentAdd.length, 4, "new rule appended");
  assert.equal(sentAdd[3].tool, "glob");
  assert(!("flags" in sentAdd[3]), "empty flags dropped");

  // 5. Invalid regex: rejected client-side, nothing sent, editor stays open
  sent.length = 0;
  await click(host.querySelectorAll(".itcp-row")[0]);
  editor = host.querySelector(".mem-expand")!;
  f = fieldVals();
  await act(async () => f.set(f.els.find((i) => i.value.startsWith("^\\s*(cat"))!, "([unclosed"));
  await save();
  assert.equal(rulesSent().length, 0, "invalid regex must not send");
  assert(host.querySelector(".mem-expand"), "editor stays open on invalid regex");

  // 6. Move down: first two rules swap; the open editor follows the moved rule
  sent.length = 0;
  const down = [...host.querySelectorAll(".mem-expand .mem-exp-head button")] as HTMLButtonElement[];
  const downBtn = down.find((b) => b.title === "下移")!;
  await act(async () => downBtn.click());
  const sentMove = rulesSent().at(-1)!.value as Array<Record<string, unknown>>;
  assert.equal(sentMove[0].tool, "grep", "moved rule lands second, grep first");
  assert.equal(sentMove[1].tool, "read");
  assert(host.querySelector(".mem-expand"), "editor follows the moved rule (object identity)");

  console.log("✓ pg-shell：拦截器/精简器成组渲染，规则编辑/新增/校验/排序 set_setting 全链路正确");
} finally {
  await act(async () => root.unmount());
  await win.happyDOM.abort();
}
