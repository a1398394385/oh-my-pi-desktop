// Ask multi-question merged submit (#5) smoke: render ApprovalCard against
// the real store with a pending approval carrying two questions (single +
// multi), pick answers, and assert ONE approval_response returns BOTH answers
// in the ExtensionAskDialogSubmitResult wire shape (kind:"submit", results[]).
// Run: PATH=… bun run scripts/smoke-ask-approval.ts
//
// Store / i18n / ApprovalCard are dynamic imports ON PURPOSE (same reason as
// smoke-react-shell.ts): module top levels touch window/document, which must
// be the happy-dom globals installed below before evaluation.
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
const { default: ApprovalCard } = await import("../ui-src/components/chat/ApprovalCard");
import type { AskQuestion } from "../ui-src/types/session";

// ---- Seed: one session with a pending two-question ask approval ----
const sent: { type: string; requestId?: string; answer?: string }[] = [];
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
        pendingApprovals: [
          {
            requestId: "r1",
            title: "部署方式",
            options: [],
            editable: false,
            prefill: "",
            answer: null,
            questions: [
              {
                id: "q0",
                question: "选一个运行环境",
                multi: false,
                recommended: 0,
                options: [{ label: "A 环境" }, { label: "B 环境", description: "预发集群" }],
              },
              {
                id: "q1",
                question: "勾选要执行的检查",
                multi: true,
                options: [{ label: "X 检查" }, { label: "Y 检查" }],
              },
            ] satisfies AskQuestion[],
          },
        ],
      },
    ],
  ]),
  ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
});

const entry = useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0];
const root = createRoot(document.getElementById("host")!);
root.render(React.createElement(ApprovalCard, { item: entry }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error("assertion failed: " + label);
};

await sleep(100);

// ---- Form shape: two question blocks, radio vs checkbox controls, Other rows ----
const blocks = [...document.querySelectorAll(".ask-q")];
ok(blocks.length === 2, "two question blocks render");
// .ask-opt inputs: q0 = A/B radios + Other radio, q1 = X/Y checkboxes + Other checkbox
const inputs = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(inputs.length === 6, "six option rows (2+Other per question)");
ok(inputs[0]?.type === "radio" && inputs[1]?.type === "radio" && inputs[2]?.type === "radio", "single question renders radios incl. Other");
ok(inputs[3]?.type === "checkbox" && inputs[4]?.type === "checkbox" && inputs[5]?.type === "checkbox", "multi question renders checkboxes incl. Other");
ok(inputs[0]?.checked === true, "single defaults to the recommended option");
ok((document.querySelector(".approval-title")?.textContent || "").includes("部署方式"), "title renders");
ok((inputs[2]?.closest("label")?.textContent || "").includes("自定义"), "Other row is labeled");
ok(document.querySelector(".approval-cancel") !== null, "cancel button renders");

// ---- Arrow-key navigation: ArrowDown walks rows in render order, across questions ----
const press = (el: Element, key: string) =>
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
inputs[0]?.focus();
press(inputs[0]!, "ArrowDown");
ok(document.activeElement === inputs[1], "ArrowDown moves q0 A -> B");
press(inputs[1]!, "ArrowDown");
ok(document.activeElement === inputs[2], "ArrowDown moves B -> Other");
press(inputs[2]!, "ArrowDown");
ok(document.activeElement === inputs[3], "ArrowDown crosses into q1 X");
press(inputs[3]!, "ArrowUp");
ok(document.activeElement === inputs[2], "ArrowUp moves back to q0 Other");

// ---- Interact: B first, then Other (exclusive), custom text, X on the multi ----
inputs[1]?.click();
await sleep(50);
ok(inputs[1]?.checked === true && inputs[0]?.checked === false, "radio switch works");
inputs[2]?.click();
await sleep(50);
ok(inputs[2]?.checked === true && inputs[1]?.checked === false, "picking Other clears the single pick");
const otherInp = document.querySelector(".ask-other input") as HTMLInputElement | null;
ok(otherInp !== null, "Other row opens its inline input");
ok(document.activeElement === otherInp, "opening Other focuses the input");
// React's value tracker syncs with the instance value setter, so dispatching
// "input" after a plain assignment reads as no-change; drive the native
// prototype setter instead (classic jsdom workaround, holds for happy-dom)
const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
nativeSetter.call(otherInp!, "手动填的答案");
otherInp!.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(50);
inputs[3]?.click();
await sleep(50);
ok(inputs[3]?.checked === true, "checkbox toggle works");

// ---- One submit returns both answers, customInput rides the Other answer ----
(document.querySelector(".approval-confirm") as HTMLButtonElement | null)?.click();
await sleep(100);
ok(sent.length === 1, "exactly one approval_response");
ok(sent[0]?.type === "approval_response" && sent[0]?.requestId === "r1", "response envelope");
const payload = JSON.parse(sent[0]?.answer ?? "null");
ok(payload?.kind === "submit", "submit kind");
ok(Array.isArray(payload?.results) && payload.results.length === 2, "both answers ride one response");
const [a0, a1] = payload.results;
ok(a0?.id === "q0" && Array.isArray(a0?.selectedOptions) && a0.selectedOptions.length === 0, "q0 selection empty under Other");
ok(a0?.customInput === "手动填的答案", "q0 customInput carries the typed answer");
ok(a0?.multi === false && Array.isArray(a0?.options) && a0.options.length === 2, "q0 meta echoes the wire shape");
ok(a1?.id === "q1" && a1?.selectedOptions.length === 1 && a1?.selectedOptions[0] === "X 检查", "q1 answer = X 检查");
ok(a1?.customInput === undefined, "q1 has no customInput without Other");
ok(a1?.multi === true, "q1 multi flag");

// ---- Frozen after answering: inputs disabled, no second send ----
// The card is prop-driven: production parents re-render it with the updated
// pendingApprovals entry, so do the same here with the store's post-submit row
const updated = useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0];
ok(typeof updated.answer === "string" && updated.answer.includes("手动填的答案"), "store entry carries the answer");
root.render(React.createElement(ApprovalCard, { item: updated }));
await sleep(50);
const frozen = [...document.querySelectorAll(".ask-opt input, .ask-other input")] as HTMLInputElement[];
ok(frozen.length === 7 && frozen.every((i) => i.disabled), "inputs frozen after submit");
ok(frozen[2]?.checked === true && frozen[4]?.checked === true && frozen[1]?.checked === false, "picks stay visible after freeze");
ok(document.querySelector(".approval-confirm") === null, "foot hides after answering");
ok(sent.length === 1, "no second response after freeze");

// ---- Cancel: a fresh pending approval, the cancel button settles as cancelled ----
const sentBefore = sent.length;
const cancelledEntry = { ...entry, requestId: "r2", answer: null, otherDrafts: undefined };
useAppStore.setState((st) => {
  const sess = st.openSessions.get("/p/s1")!;
  return { openSessions: new Map(st.openSessions).set("/p/s1", { ...sess, pendingApprovals: [cancelledEntry] }) };
});
// key by requestId like App.tsx does in production: a new request remounts the
// card (component-local state such as askDoneRef must not carry over)
root.render(React.createElement(ApprovalCard, { key: "r2", item: cancelledEntry }));
await sleep(50);
(document.querySelector(".approval-cancel") as HTMLButtonElement | null)?.click();
await sleep(50);
ok(sent.length === sentBefore + 1, "cancel sends one response");
ok(sent[sent.length - 1]?.answer === "cancel", "cancel answer is the literal cancel string");
const afterCancel = useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0];
ok(afterCancel.answer === "cancel", "store entry freezes on cancel");

root.unmount();
console.log("smoke-ask-approval: all assertions passed");
process.exit(0);
