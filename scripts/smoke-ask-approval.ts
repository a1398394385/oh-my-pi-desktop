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

// happy-dom has no layout and the Bun host has no Element global: the card's
// global key capture bails when the card reports no client rects (its
// hidden-card guard) and its instanceof check needs the global. Stub both so
// arrow navigation runs — the visible-card state production renders in.
globalThis.Element ??= window.Element;
window.Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;

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

// ---- Form shape: one question per page; the head pager flips between them ----
// Page 1 (q0): A/B radios + Other radio; the head carries the page number + prev/next
const blocks = [...document.querySelectorAll(".ask-q")];
ok(blocks.length === 1, "one question renders per page");
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("1 / 2"), "head pager shows 1 / 2");
ok(document.querySelector(".ask-nav") === null, "the old bottom pager bar is gone");
const prevBtn = document.querySelector<HTMLButtonElement>(".ask-page-btn");
ok(prevBtn?.disabled === true, "prev disabled on the first page");
// .ask-opt rows: q0 = A/B radios + Other radio
const inputs = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(inputs.length === 3, "three option rows on page 1 (2 options + Other)");
ok(inputs[0]?.type === "radio" && inputs[1]?.type === "radio" && inputs[2]?.type === "radio", "single question renders radios incl. Other");
ok(inputs[0]?.checked === true, "single defaults to the recommended option");
// Head carries the current page's question (bold) — the title row no longer renders on the ask variant
ok(document.querySelector(".approval-title") === null, "ask variant has no title row");
ok((document.querySelector(".ask-head-q")?.textContent || "").includes("选一个运行环境"), "head renders the question");
// Single-choice rows carry 1./2. numbers; the multi page (checked further below) must not
ok((inputs[0]?.closest(".ask-opt")?.querySelector(".approval-num")?.textContent || "") === "1.", "option rows are numbered");
ok((inputs[2]?.closest(".ask-opt")?.querySelector(".approval-num")?.textContent || "") === "3.", "Other row carries the next number");
ok((inputs[2]?.closest(".ask-opt")?.textContent || "").includes("自定义"), "Other row is labeled");
ok(document.querySelector(".approval-cancel") !== null, "cancel button renders");

// ---- Row click selects: clicking the ROW (not just the input) toggles the pick ----
// The picked single-choice row auto-advances, so its radio state is asserted
// after flipping back below (a page flip unmounts the old rows).
const rowsOf = () => [...document.querySelectorAll(".ask-opt")];
rowsOf()[1]?.click(); // row div click, not the input's own click
await sleep(50);
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("2 / 2"), "single-choice pick auto-advances to page 2");

// ---- Page 2 (q1): checkboxes; arrow keys walk rows without toggling them ----
const page2 = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(page2.length === 3 && page2.every((i) => i.type === "checkbox"), "multi question renders checkboxes incl. Other");
ok((rowsOf()[0]?.textContent ?? "").includes("X 检查"), "page 2 shows the multi question's options");
const press = (el: Element, key: string) =>
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
page2[0]?.focus();
press(page2[0]!, "ArrowDown");
ok(document.activeElement === page2[1], "ArrowDown moves q1 X -> Y");
press(page2[1]!, "ArrowDown");
ok(document.activeElement === page2[2], "ArrowDown crosses into the Other row");
press(page2[2]!, "ArrowUp");
ok(document.activeElement === page2[1], "ArrowUp moves back to Y");

// ---- Interact: check via the input, uncheck via the row div, recheck via the row ----
page2[0]?.click();
await sleep(50);
ok(page2[0]?.checked === true, "checkbox toggles on a direct input click");
rowsOf()[0]?.click();
await sleep(50);
ok(page2[0]?.checked === false, "row click unchecks a checked box (one toggle per click)");
rowsOf()[0]?.click();
await sleep(50);
ok(page2[0]?.checked === true, "row click rechecks the box");

// ---- Back to page 1 through the head pager; q1's pick survives the flip ----
const pagerBtns = [...document.querySelectorAll<HTMLButtonElement>(".ask-page-btn")];
ok(pagerBtns.length === 2 && pagerBtns[1]?.disabled === true, "next disabled on the last page");
pagerBtns[0]?.click();
await sleep(50);
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("1 / 2"), "head prev returns to page 1");
const back = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(back[1]?.checked === true, "page-1 pick (滚动发布) survived the flip");

// ---- Arrow keys on a single-choice page move the cursor without answering ----
// Landing on a row still checks it (the checked plate is the row highlight),
// but the move must not settle the page: arrows only navigate, Enter commits.
const sentBeforeArrows = sent.length;
back[0]?.focus();
press(back[0]!, "ArrowDown");
await sleep(50);
ok(document.activeElement === back[1], "ArrowDown moves the single-choice cursor A -> B");
ok(back[1]?.checked === true, "the cursor row is checked");
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("1 / 2"), "ArrowDown does not auto-advance the page");
ok(sent.length === sentBeforeArrows, "ArrowDown does not submit");

// ---- Arrow onto the Other row opens it: one highlight, Enter hands over the custom answer ----
press(back[1]!, "ArrowDown");
await sleep(50);
const arrowOther = document.querySelector(".ask-other input") as HTMLInputElement | null;
ok(arrowOther !== null, "ArrowDown onto the Other row opens its input");
ok(document.activeElement === arrowOther, "the opened Other input takes the focus");
ok(back[2]?.checked === true && back[1]?.checked === false, "the Other row ends up as the only checked row");
ok(sent.length === sentBeforeArrows, "opening Other with an arrow does not submit");
// Enter here must not fall back to the previously picked option
press(arrowOther!, "Enter");
await sleep(50);
ok(sent.length === sentBeforeArrows, "Enter on an empty Other row submits nothing");
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("1 / 2"), "Enter on an empty Other row stays on the page");
// Up from the input returns to the previous option: an open Other row is one stop, not two
press(arrowOther!, "ArrowUp");
await sleep(50);
ok(document.activeElement === back[1], "ArrowUp from the Other input returns to B");
ok(back[1]?.checked === true && document.querySelector(".ask-other") === null, "leaving the Other row restores the option pick and closes it");

// ---- Digit keys quick-pick: "1" answers option A and auto-advances the page ----
press(back[0]!, "1");
await sleep(50);
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("2 / 2"), "digit pick auto-advances");
const pagerBtns2 = [...document.querySelectorAll<HTMLButtonElement>(".ask-page-btn")];
pagerBtns2[0]?.click();
await sleep(50);
const back2 = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(back2[0]?.checked === true, "digit-1 pick (A) survived the flip");

// ---- Answer q0 through "Other" (row click) + custom text, then advance via the head next ----
back2[2]?.click();
await sleep(50);
ok(back2[2]?.checked === true && back2[0]?.checked === false, "picking Other clears the single pick");
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
([...document.querySelectorAll<HTMLButtonElement>(".ask-page-btn")][1])?.click();
await sleep(50);
ok((document.querySelector(".ask-page")?.textContent ?? "").includes("2 / 2"), "head next advances the answered page");
// page 2 remounts on the flip: re-query before reading the checkbox state
const page2Again = [...document.querySelectorAll<HTMLInputElement>(".ask-opt input")];
ok(page2Again[0]?.checked === true, "q1 pick survived returning to page 2");

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

// ---- Frozen after answering: the last page's inputs disabled, no second send ----
// The card is prop-driven: production parents re-render it with the updated
// pendingApprovals entry, so do the same here with the store's post-submit row
const updated = useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0];
ok(typeof updated.answer === "string" && updated.answer.includes("手动填的答案"), "store entry carries the answer");
root.render(React.createElement(ApprovalCard, { item: updated }));
await sleep(50);
const frozen = [...document.querySelectorAll(".ask-opt input")] as HTMLInputElement[];
ok(frozen.length === 3 && frozen.every((i) => i.disabled), "inputs frozen after submit");
ok(frozen[0]?.checked === true && frozen[1]?.checked === false, "picks stay visible after freeze");
ok(document.querySelector(".ask-pager") === null, "head pager hides after answering");
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

// ---- Single-question ask: the row click answers AND submits ----
// A one-page form has no next page to auto-advance to, so the row click must
// settle the ask; otherwise the mouse has no submit path (the same gap hits
// the last page of a multi-question ask when its question is single-choice).
const sentBeforeSingle = sent.length;
const singleEntry = {
  ...entry,
  requestId: "r3",
  answer: null,
  otherDrafts: undefined,
  questions: [
    {
      id: "q0",
      question: "选一个运行环境",
      multi: false,
      recommended: 0,
      options: [{ label: "A 环境" }, { label: "B 环境" }],
    },
  ] satisfies AskQuestion[],
};
useAppStore.setState((st) => {
  const sess = st.openSessions.get("/p/s1")!;
  return { openSessions: new Map(st.openSessions).set("/p/s1", { ...sess, pendingApprovals: [singleEntry] }) };
});
root.render(React.createElement(ApprovalCard, { key: "r3", item: singleEntry }));
await sleep(50);
ok(document.querySelector(".ask-pager") === null, "single-question ask renders no pager");
ok(document.querySelector(".approval-confirm") !== null, "single-question ask offers the submit button");
rowsOf()[1]?.click();
await sleep(50);
ok(sent.length === sentBeforeSingle + 1, "row click on a single-question ask submits");
const singlePayload = JSON.parse(sent[sent.length - 1]?.answer ?? "null");
ok(singlePayload?.kind === "submit" && singlePayload?.results?.[0]?.selectedOptions?.[0] === "B 环境", "the clicked option rides the submitted answer");

root.unmount();
console.log("smoke-ask-approval: all assertions passed");
process.exit(0);
