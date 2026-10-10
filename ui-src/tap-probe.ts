// [TAPLOG] Temporary tap-to-click diagnostics probe (BUG: trackpad tap often
// not registered in WKWebView). Enabled by default; set localStorage
// `taplog = "0"` and restart to silence. Logs every pointer/mouse/force event
// with timing, target and button state so a failed tap can be told apart from
// a swallowed click, a DOM retarget, or an event that never reached the page.
// Delete this file and its main.tsx import once the bug is closed.

interface TapRow {
  t: string;
  type: string;
  tgt: string;
  x: number;
  y: number;
  button: number;
  buttons: number;
  detail: number;
  pointerType: string;
  force: number | "-";
  trusted: boolean;
}

const rows: TapRow[] = [];

const label = (el: EventTarget | null): string => {
  if (!(el instanceof Element)) return String(el);
  // getAttribute covers both HTML and SVG (className is deprecated on Element).
  const cls = (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(".");
  return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${el.id ? "#" + el.id : ""}`;
};

// webkitmouseforce* only fire on real deep presses, never on tap-to-click —
// that asymmetry is what marks each logged attempt as tap vs press.
const TYPES = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "contextmenu",
  "webkitmouseforcewillbegin",
  "webkitmouseforcebegin",
  "webkitmouseforcechange",
  "webkitmouseforcedrag",
  "webkitmouseforceup",
] as const;

for (const type of TYPES) {
  window.addEventListener(
    type,
    (e) => {
      const isMouse = e instanceof MouseEvent;
      let force: number | "-" = "-";
      if ("force" in e) {
        const raw: unknown = e.force;
        if (typeof raw === "number") force = +raw.toFixed(2);
      }
      let pointerType = "-";
      if ("pointerType" in e) {
        const raw: unknown = e.pointerType;
        if (typeof raw === "string") pointerType = raw;
      }
      const row: TapRow = {
        t: (e.timeStamp / 1000).toFixed(3),
        type,
        tgt: label(e.target),
        x: isMouse ? Math.round(e.clientX) : -1,
        y: isMouse ? Math.round(e.clientY) : -1,
        button: isMouse ? e.button : -1,
        buttons: isMouse ? e.buttons : -1,
        detail: isMouse ? e.detail : -1,
        pointerType,
        force,
        trusted: e.isTrusted,
      };
      rows.push(row);
      console.log("[TAPLOG]", JSON.stringify(row));
    },
    { capture: true, passive: true },
  );
}

// Console retrieval handle for the log collector.
Object.assign(window, { __taplog: rows });
console.log("[TAPLOG] armed — reproduce the missed taps, then copy JSON.stringify(window.__taplog)");

export {};
