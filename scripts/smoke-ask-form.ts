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
const form: AskFormWire = {
  sections: [
    {
      title: [{ text: "Deploy settings" }],
      fieldset: true,
      blocks: [
        { kind: "text", spans: [{ text: "Confirm these settings" }, { text: " (fill the required fields first)", style: "em" }], heading: false },
        { kind: "field", field: radio },
        { kind: "field", field: checks },
        { kind: "field", field: port },
      ],
    },
  ],
  fields: [radio, checks, port],
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
const parsed = JSON.parse(reply.answer!) as { kind: string; data: Record<string, unknown> };
ok(parsed.kind === "submit", "submission is a submit payload");
ok(parsed.data.token === "t0", "hidden input rides into the data");
ok(parsed.data.env === "b", "single choice submits the picked value");
ok(JSON.stringify(parsed.data.checks) === JSON.stringify(["y", "x"]), "checkbox group submits every checked value");
ok(parsed.data.port === 8081, "numeric field submits a number");

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
ok(document.querySelector(".ask-other input") !== null, "the Other row opens its input");
ok(
  [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].slice(0, 2).every((r) => !r.checked),
  "opening Other drops the radio pick",
);

console.log("ask form smoke passed ✓");
