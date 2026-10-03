// Ghost inline completion (complete_text RPC) three-state smoke: mount a real
// Lexical editor + GhostTextPlugin in happy-dom against the real store with a
// fake WS, drive render / accept / discard (+ IME composition guard) through
// the editor itself and assert on the DOM and the captured wire.
// Run: PATH=… bun run scripts/smoke-ghost-text.ts
//
// The store / i18n / plugin modules are dynamic imports ON PURPOSE (same
// reason as smoke-react-shell.ts): their module top levels touch window /
// document, which must be the happy-dom globals installed below before
// evaluation; a static import would run them first.
import { Window } from "happy-dom";
import type { LexicalEditor, RangeSelection } from "lexical";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

// Same global scaffold as smoke-react-shell, plus MutationObserver (present on
// the happy-dom window, absent from the Bun global scope) so Lexical mounts
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
// DOM constructor globals: lexical's reconciler references Node/Element from
// the bare global scope; happy-dom only exposes them on its window
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Document = window.Document;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Text = window.Text;
globalThis.Range = window.Range;

document.body.innerHTML = '<div id="host"></div>';

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../ui-src/store");
const { LexicalComposer } = await import("@lexical/react/LexicalComposer");
const { RichTextPlugin } = await import("@lexical/react/LexicalRichTextPlugin");
const { ContentEditable } = await import("@lexical/react/LexicalContentEditable");
const { LexicalErrorBoundary } = await import("@lexical/react/LexicalErrorBoundary");
const { HistoryPlugin } = await import("@lexical/react/LexicalHistoryPlugin");
const { useLexicalComposerContext } = await import("@lexical/react/LexicalComposerContext");
const { KEY_TAB_COMMAND, $getSelection, $isRangeSelection } = await import("lexical");
const { $setText, $flattenText } = await import("../ui-src/components/composer/lexical/flat");
const { default: GhostTextPlugin } = await import("../ui-src/components/composer/lexical/GhostTextPlugin");
const { GhostNode } = await import("../ui-src/components/composer/lexical/GhostNode");

// ---- Store seeding: active session + fake WS capturing sends ----
const sent: { type: string; sessionId?: string; text?: string }[] = [];
useAppStore.setState({
  activePath: "/p/s1",
  openSessions: new Map([
    [
      "/p/s1",
      {
        sessionId: "s1",
        items: [],
        assistantDraft: "",
        streaming: false,
        subagents: new Map(),
        model: "m",
        thinking: "off",
        isGit: false,
        todos: [],
        pendingApprovals: [],
      },
    ],
  ]),
  ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
});

// ---- Mount the editor ----
const typeaheadOpenRef = { current: false };
let editorRef: LexicalEditor | null = null;
function Capture() {
  const [editor] = useLexicalComposerContext();
  editorRef = editor;
  return null;
}

const root = createRoot(document.getElementById("host")!);
root.render(
  React.createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: "ghost-smoke",
        onError(err: Error) {
          throw err;
        },
        nodes: [GhostNode],
      },
    },
    React.createElement(RichTextPlugin, {
      contentEditable: React.createElement(ContentEditable),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
    React.createElement(HistoryPlugin),
    React.createElement(GhostTextPlugin, { typeaheadOpenRef }),
    React.createElement(Capture),
  ),
);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error("assertion failed: " + label);
};
const typeText = (t: string) =>
  editor.update(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) (sel as RangeSelection).insertText(t);
  });

await sleep(100);
const editor = editorRef;
if (!editor) throw new Error("editor not captured");

// ---- 1) debounce request: type, pause 200ms, exactly one complete_text ----
editor.update(() => $setText("hello wor"));
await sleep(400);
ok(sent.length === 1, "exactly one request after the typing pause");
ok(sent[0]?.type === "complete_text" && sent[0]?.sessionId === "s1" && sent[0]?.text === "hello wor", "request shape");

// ---- 2) render: reply lands as ghost text, flattened text untouched ----
useAppStore.setState({ completionResult: { sessionId: "s1", suggestion: "ld" } });
await sleep(80);
ok(document.querySelector(".ghost-t")?.textContent === "ld", "ghost renders the suggestion");
ok(editor.read(() => $flattenText()) === "hello wor", "ghost invisible to the flattened text");

// stale reply (other session) must not render
editor.update(() => $setText("other tex"));
await sleep(400);
sent.length = 0;
useAppStore.setState({ completionResult: { sessionId: "zzz", suggestion: "NO" } });
await sleep(80);
ok(!document.querySelector(".ghost-t"), "stale session reply dropped");
ok(editor.read(() => $flattenText()) === "other tex", "text untouched by the stale reply");

// ---- 3) accept: Tab replaces the ghost with real text ----
editor.update(() => $setText("hello wor"));
await sleep(400);
useAppStore.setState({ completionResult: { sessionId: "s1", suggestion: "ld" } });
await sleep(80);
ok(document.querySelector(".ghost-t")?.textContent === "ld", "ghost re-rendered for accept");
editor.dispatchCommand(
  KEY_TAB_COMMAND,
  {
    preventDefault() {},
  } as unknown as KeyboardEvent,
);
await sleep(80);
ok(editor.read(() => $flattenText()) === "hello world", "Tab accepted the suggestion into the text");
ok(!document.querySelector(".ghost-t"), "no ghost after accept");
// chaining: the accept re-arms the debounce -> a follow-up request fires
await sleep(300);
ok(sent.some((m) => m.type === "complete_text" && m.text === "hello world"), "accept chains the next request");

// ---- 4) discard: typing kills the ghost ----
sent.length = 0;
useAppStore.setState({ completionResult: { sessionId: "s1", suggestion: " again" } });
await sleep(80);
ok(document.querySelector(".ghost-t")?.textContent === " again", "ghost for the discard case");
typeText("X");
await sleep(80);
ok(!document.querySelector(".ghost-t"), "typing discards the ghost");
ok(editor.read(() => $flattenText()) === "hello worldX", "discard keeps only the typed text");

// ---- 5) IME: compositionstart cancels requests and drops the ghost ----
// Synthetic composition events + editor.update edits inside the window fight
// Lexical's own composition reconciliation (a test-only artifact), so the
// model is only edited OUTSIDE the window: the debounce timer is armed just
// before compositionstart opens, fires inside the window (guard: no request),
// and a fresh edit after compositionend resumes requests.
const rootEl = editor.getRootElement();
editor.update(() => $setText("comp "));
await sleep(400);
sent.length = 0;
useAppStore.setState({ completionResult: { sessionId: "s1", suggestion: "ghost-during-ime" } });
await sleep(80);
ok(!!document.querySelector(".ghost-t"), "ghost present before composition");
rootEl?.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
await sleep(50);
ok(!document.querySelector(".ghost-t"), "compositionstart drops the ghost");
editor.update(() => $setText("comp 中")); // arms the debounce; fires mid-composition
rootEl?.dispatchEvent(new window.Event("compositionstart", { bubbles: true }));
await sleep(400);
ok(sent.length === 0, "no request while composing");
rootEl?.dispatchEvent(new window.Event("compositionend", { bubbles: true }));
editor.update(() => $setText("comp 中文"));
await sleep(400);
ok(sent.length === 1 && sent[0]?.text === "comp 中文", "requests resume after compositionend");

// empty suggestion: silent close (no ghost, no crash)
useAppStore.setState({ completionResult: { sessionId: "s1", suggestion: "" } });
await sleep(80);
ok(!document.querySelector(".ghost-t"), "empty suggestion closes silently");

root.unmount();
console.log("smoke-ghost-text: all assertions passed");
process.exit(0);
