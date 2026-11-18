// Ask form card (18.20 uiCtx.formDialog) smoke: render AskFormCard against the
// real store with one parsed <form> (radio + "Other", checkbox group, numeric
// text field, hidden input), fill it, and assert ONE approval_response carries
// the whole submission as { kind: "submit", data } — plus that a missing
// required answer blocks the submit instead of sending an empty field.
// Run: PATH=… bun run scripts/smoke-ask-form.ts
//
// Store / i18n / the card are dynamic imports ON PURPOSE (same reason as
// smoke-react-shell.ts): module top levels touch window/document, which must be
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

window.Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
document.body.innerHTML = '<div id="host"></div>';

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAppStore } = await import("../ui-src/store");
const { default: AskFormCard } = await import("../ui-src/components/chat/AskFormCard");
import type { AskFormField, AskFormWire } from "../ui-src/types/session";
// Pure logic, no window/document: safe to load before happy-dom installs globals.
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { formSubmission } from "../host/form-submission.ts";

// ---- Seed: one session with a pending formDialog approval ----
const radio: AskFormField = {
  kind: "choice",
  name: "env",
  multi: false,
  select: false,
  other: true,
  label: [],
  required: true,
  options: [
    { value: "a", label: [{ text: "Env A" }], checked: true, disabled: false },
    { value: "b", label: [{ text: "Env B" }], checked: false, disabled: false },
  ],
};
const checks: AskFormField = {
  kind: "choice",
  name: "checks",
  multi: true,
  select: false,
  other: false,
  label: [{ text: "Which checks run" }],
  required: false,
  options: [
    { value: "x", label: [{ text: "Check X" }], checked: false, disabled: false },
    { value: "y", label: [{ text: "Check Y" }], checked: true, disabled: false },
    { value: "z", label: [{ text: "Check Z" }], checked: false, disabled: true },
  ],
};
const port: AskFormField = {
  kind: "text",
  name: "port",
  type: "number",
  multiline: false,
  label: [{ text: "Port" }],
  value: "",
  placeholder: "8080",
  required: true,
  rows: 1,
};
// A second question group: the card pages one group at a time.
const mode: AskFormField = {
  kind: "choice",
  name: "mode",
  multi: false,
  select: false,
  other: false,
  label: [{ text: "Mode" }],
  required: false,
  options: [{ value: "fast", label: [{ text: "Fast" }], checked: true, disabled: false }],
};
const form: AskFormWire = {
  sections: [
    {
      title: [{ text: "Deploy settings" }],
      fieldset: true,
      blocks: [
        { kind: "text", spans: [{ text: "Confirm these settings" }, { text: " (fill the required fields first)", style: "em" }], heading: false },
        // Pictures the host inlined (inline svg / workspace paths arrive as data URIs);
        // a source it could not resolve keeps its path and falls back to the alt text.
        { kind: "image", src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==", alt: "inlined" },
        { kind: "image", src: ".local/missing.png", alt: "unreachable" },
        { kind: "field", field: radio },
        { kind: "field", field: checks },
        { kind: "field", field: port },
      ],
    },
    {
      title: [{ text: "Runtime" }],
      fieldset: true,
      blocks: [{ kind: "field", field: mode }],
    },
  ],
  fields: [radio, checks, port, mode],
  hidden: [["token", "t0"]],
};

const sent: { type: string; requestId?: string; answer?: string }[] = [];
useAppStore.setState({
  activePath: "/p/s1",
  openSessions: new Map([
    [
      "/p/s1",
      {
        sessionId: "s1",
        cwd: "/p",
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
            title: "Deploy settings",
            options: ["submit", "cancel"],
            editable: false,
            prefill: "",
            answer: null,
            form,
          },
        ],
      },
    ],
  ]),
  ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket,
});

const entry = useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0];
const root = createRoot(document.getElementById("host")!);
root.render(React.createElement(AskFormCard, { item: entry }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error("assertion failed: " + label);
};
// React ignores a plain `el.value = v`; the native setter plus an input event is
// what its onChange listens for.
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
};

await sleep(100);

// ---- Shape: one card, sections drawn in document order ----
ok(document.querySelector(".ask-form") !== null, "form container renders");
ok((document.querySelector(".ask-form-heading")?.textContent ?? "") === "Deploy settings", "section title renders");
ok((document.querySelectorAll(".ask-form p").length ?? 0) === 1, "context paragraph renders above the fields");
ok(document.querySelectorAll(".ask-q").length === 3, "three fields render (radio, checkbox group, text)");
ok(document.querySelector("form.ask-form") !== null, "the card is a real form (submit button needs no key handler)");
ok(document.querySelectorAll("fieldset.ask-field").length === 3, "each question is its own fieldset");
ok(document.querySelector("fieldset.ask-field > legend") !== null, "the question label is the fieldset legend");
ok(document.querySelector(".ask-page")?.textContent === "1/2", "the pager shows the position");
ok(document.querySelector(".ask-head-q")?.textContent === "Deploy settings", "the head carries the ask title");
ok(document.querySelector(".approval-title") === null, "the title is not printed twice");

// ---- Collapse to a summary bar and back ----
document.querySelector<HTMLElement>(".ask-collapse-btn")?.click();
await sleep(60);
ok(document.querySelector(".approval-min") !== null, "the card collapses to one bar");
ok(document.querySelector(".ask-form") === null, "the collapsed card drops the form");
document.querySelector<HTMLElement>(".approval-min")?.click();
await sleep(60);
ok(document.querySelector("form.ask-form") !== null, "clicking the bar brings the form back");

// ---- One page per question group: the next question is not on this page ----
document.querySelectorAll<HTMLElement>(".ask-page-btn")[1]?.click();
await sleep(50);
ok(document.querySelector(".ask-page")?.textContent === "2/2", "next turns the page");
ok(document.querySelectorAll(".ask-q").length === 1, "the page shows only its own question");
ok(document.querySelector(".ask-form-heading")?.textContent === "Runtime", "the page shows its own heading");
document.querySelectorAll<HTMLElement>(".ask-page-btn")[0]?.click();
await sleep(50);
ok(document.querySelectorAll(".ask-q").length === 3, "previous returns to the first page");
const pictured = document.querySelector<HTMLImageElement>(".ask-form-img");
ok(pictured?.src.startsWith("data:image/svg+xml") === true, "an inlined picture draws");
ok(
  document.querySelector(".ask-form-img-alt")?.textContent === "unreachable",
  "an unresolvable source falls back to its alt text",
);

const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
ok(radios.length === 3, "radio group = 2 options + Other");
ok(radios[0]?.checked === true, "preselected option opens checked");
const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
ok(boxes.length === 2, "disabled option is not drawn (2 of 3 checkboxes)");
ok(boxes[1]?.checked === true, "preselected checkbox opens checked");
const portInp = document.querySelector<HTMLInputElement>(".ask-q input[type='number']");
ok(portInp?.placeholder === "8080", "placeholder rides the frame into the field");
ok(portInp?.value === "", "prefilled text opens empty here");

// ---- Required answer blocks the submit: no frame, one inline error ----
document.querySelector<HTMLButtonElement>(".approval-confirm")?.click();
await sleep(50);
ok(sent.length === 0, "submit with an empty required field sends nothing");
ok(document.querySelector(".ask-form-error") !== null, "the missing field is named");

// ---- Fill and submit: one answer carries every field ----
document.querySelectorAll<HTMLElement>(".ask-opt")[1]?.click(); // pick Env B
await sleep(50);
ok(radios[1]?.checked === true, "clicking the row picks the option");
await sleep(10);
const boxes2 = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
boxes2[0]?.click(); // add X, keep preset Y
await sleep(50);
const boxes3 = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
ok(boxes3[0]?.checked === true && boxes3[1]?.checked === true, "checkbox group keeps both picks");
type(document.querySelector<HTMLInputElement>(".ask-q input[type='number']")!, "8081");
await sleep(50);

document.querySelector<HTMLButtonElement>(".approval-confirm")?.click();
await sleep(80);
ok(sent.length === 1, "one approval_response leaves the card");
const reply = sent[0]!;
ok(reply.type === "approval_response" && reply.requestId === "r1", "the reply targets this request");
const parsed = JSON.parse(reply.answer!) as { kind: string; data: Record<string, unknown>; notes?: unknown };
ok(parsed.kind === "submit", "submission is a submit payload");
ok(parsed.data.token === "t0", "hidden input rides into the data");
ok(parsed.data.env === "b", "single choice submits the picked value");
ok(JSON.stringify(parsed.data.checks) === JSON.stringify(["y", "x"]), "checkbox group submits every checked value");
ok(parsed.data.port === 8081, "numeric field submits a number");
ok(parsed.notes === undefined, "an empty note row stays out of the submission");

// ---- Question-level note: one row on the single-choice field, and it rides the
// submission trimmed. Multi-select and text fields carry no row.
sent.length = 0;
root.render(React.createElement(AskFormCard, { key: "note", item: { ...entry, answer: null } }));
await sleep(80);
ok(document.querySelectorAll(".ask-note").length === 1, "only the single-choice field carries a note row");
type(document.querySelector<HTMLInputElement>(".ask-note-inp")!, "  keep the JSONL copy  ");
type(document.querySelector<HTMLInputElement>(".ask-q input[type='number']")!, "8082");
await sleep(80);
document.querySelector<HTMLButtonElement>(".approval-confirm")?.click();
await sleep(100);
const noted = JSON.parse(sent[0]!.answer!) as { notes?: { name: string; text: string }[] };
ok(noted.notes?.length === 1, "a typed note rides the submission");
ok(noted.notes![0]!.name === "env", "the note names its field");
ok(noted.notes![0]!.text === "keep the JSONL copy", "the note text is trimmed");

// ---- A typed Other answer is exclusive with the radio pick ----
useAppStore.setState({
  openSessions: new Map([
    [
      "/p/s1",
      {
        ...useAppStore.getState().openSessions.get("/p/s1")!,
        pendingApprovals: [{ ...entry, answer: null }],
      },
    ],
  ]),
});
sent.length = 0;
root.render(React.createElement(AskFormCard, { item: { ...entry, answer: null } }));
await sleep(60);
document.querySelectorAll<HTMLElement>(".ask-other-opt")[0]?.click();
await sleep(50);
ok(document.querySelector(".ask-other-opt input.ask-other-inp") !== null, "the Other row carries its input");
ok(
  [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].slice(0, 2).every((r) => !r.checked),
  "opening Other drops the radio pick",
);
ok(document.querySelector(".ask-req") !== null, "a required field marks its label");
ok(document.querySelector(".approval-num") === null, "option rows draw no index number");

// ---- Esc cancels: the form owns the key, the card is not a modal ----
// Fresh root: the earlier submit set the card's done flag, and a settled card
// ignores further answers by design.
root.unmount();
sent.length = 0;
const escRoot = createRoot(document.getElementById("host")!);
escRoot.render(React.createElement(AskFormCard, { item: { ...entry, answer: null } }));
await sleep(60);
document
  .querySelector("form.ask-form")!
  .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(60);
ok(sent.length === 1 && sent[0]!.answer === "cancel", "Esc cancels the form");
escRoot.unmount();

// ---- A single pick advances the page; the last page submits on pick ----
const q1: AskFormField = {
  kind: "choice",
  name: "one",
  multi: false,
  select: false,
  other: false,
  label: [{ text: "Question one" }],
  required: true,
  options: [
    { value: "a", label: [{ text: "A" }], checked: false, disabled: false },
    { value: "b", label: [{ text: "B" }], checked: false, disabled: false },
  ],
};
const q2: AskFormField = {
  kind: "choice",
  name: "two",
  multi: false,
  select: false,
  other: false,
  label: [{ text: "Question two" }],
  required: true,
  options: [
    { value: "c", label: [{ text: "C" }], checked: false, disabled: false },
    { value: "d", label: [{ text: "D" }], checked: false, disabled: false },
  ],
};
const paged: AskFormWire = {
  sections: [
    { title: [{ text: "First" }], fieldset: true, blocks: [{ kind: "field", field: q1 }] },
    { title: [{ text: "Second" }], fieldset: true, blocks: [{ kind: "field", field: q2 }] },
  ],
  fields: [q1, q2],
  hidden: [],
};
sent.length = 0;
useAppStore.setState({
  openSessions: new Map([
    [
      "/p/s1",
      {
        ...useAppStore.getState().openSessions.get("/p/s1")!,
        pendingApprovals: [{ ...entry, form: paged, title: "Two questions", answer: null }],
      },
    ],
  ]),
});
const pickRoot = createRoot(document.getElementById("host")!);
pickRoot.render(
  React.createElement(AskFormCard, { item: useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0] }),
);
await sleep(80);
ok(document.querySelector(".ask-page")?.textContent === "1/2", "two question groups make two pages");
document.querySelector<HTMLInputElement>('input[aria-label="A"]')?.click();
await sleep(80);
ok(sent.length === 0, "a pick on a middle page does not submit");
ok(document.querySelector(".ask-page")?.textContent === "2/2", "a pick advances to the next page");
document.querySelector<HTMLInputElement>('input[aria-label="C"]')?.click();
await sleep(120);
ok(sent.length === 1, "a pick on the last page submits");
const auto = JSON.parse(sent[0]!.answer!) as { kind: string; data: Record<string, unknown> };
ok(auto.kind === "submit" && auto.data.one === "a" && auto.data.two === "c", "the submission carries both picks");
pickRoot.unmount();

// ---- Enter follows a click's rule: confirm the answer, turn the page, submit
// only on the last page (the browser's implicit submit would settle page one) ----
sent.length = 0;
useAppStore.setState({
  openSessions: new Map([
    [
      "/p/s1",
      {
        ...useAppStore.getState().openSessions.get("/p/s1")!,
        pendingApprovals: [{ ...entry, form: paged, title: "Two questions", answer: null }],
      },
    ],
  ]),
});
const enterRoot = createRoot(document.getElementById("host")!);
enterRoot.render(
  React.createElement(AskFormCard, { item: useAppStore.getState().openSessions.get("/p/s1")!.pendingApprovals![0] }),
);
await sleep(80);
const pressEnter = (el: Element | null) =>
  el?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
pressEnter(document.querySelector('input[aria-label="A"]'));
await sleep(80);
ok(sent.length === 0, "Enter on a middle page does not submit");
ok(document.querySelector(".ask-page")?.textContent === "2/2", "Enter confirms the pick and turns the page");
pressEnter(document.querySelector('input[aria-label="C"]'));
await sleep(120);
ok(sent.length === 1, "Enter on the last page submits");
const byEnter = JSON.parse(sent[0]!.answer!) as { kind: string; data: Record<string, unknown> };
ok(byEnter.data.one === "a" && byEnter.data.two === "c", "Enter submits the picks a click would");
enterRoot.unmount();

// ---- Deadline countdown: the foot names what the host will do, the collapsed
// bar keeps showing the remainder. No submit from the card itself (the host's
// timer is the only one), so nothing may reach the socket here.
sent.length = 0;
const cdRoot = createRoot(document.getElementById("host")!);
cdRoot.render(React.createElement(AskFormCard, { item: { ...entry, answer: null, expiresAt: Date.now() + 12_000 } }));
await sleep(80);
const hint = document.querySelector(".approval-hint")?.textContent ?? "";
ok(/^\d+s 后按默认答案提交$/.test(hint), "the foot reports the auto-submit deadline");
ok(!hint.includes("所有答案一起提交"), "the deadline replaces the plain hint");
document.querySelector<HTMLElement>(".ask-collapse-btn")?.click();
await sleep(60);
const cd = document.querySelector(".approval-min .ask-deadline")?.textContent ?? "";
ok(/^\d+s$/.test(cd), "the collapsed bar keeps the countdown");
ok(sent.length === 0, "the countdown never submits on its own");
cdRoot.unmount();

// ---- Host side: the answer parse fills the base's option-level shape from the
// parsed form, because the card only knows the field name and the typed text.
const wired = parseHtmlForm(`<form><fieldset><legend>Deploy settings</legend>
<label><input type="radio" name="env" value="a" checked> Env A</label>
<label><input type="radio" name="env" value="b"> Env B</label>
</fieldset></form>`);
const submitWithNote = formSubmission(
  wired,
  JSON.stringify({ kind: "submit", data: { env: "b" }, notes: [{ name: "env", text: "staging only" }] }),
);
ok(submitWithNote?.data.env === "b", "the host passes the answers through");
ok(submitWithNote?.notes?.[0]?.question === "Deploy settings", "the note names its question");
ok(submitWithNote?.notes?.[0]?.option === "Env B", "the note names the picked option");
ok(submitWithNote?.notes?.[0]?.value === "b", "the note carries the wire value");
ok(submitWithNote?.notes?.[0]?.text === "staging only", "the note text survives the parse");
ok(
  formSubmission(wired, JSON.stringify({ kind: "submit", data: { env: "b" } }))?.notes === undefined,
  "no notes leaves the field out",
);
ok(formSubmission(wired, JSON.stringify({ kind: "cancel" })) === undefined, "a non-submit payload cancels");

console.log("ask form smoke passed ✓");
