// Message rail: the vertical tick bar on the left of the main chat area, one tick per user
// message, hovering pops a message card.
// Migrated from buildMsgRail/paintRailAt/showRailPop in ui/ringpop.js — tick positioning
// relies on getBoundingClientRect measuring the actual layout, and the interactions
// (mousemove continuous peaks / hover grace-period popcard / click-to-scroll) rely on
// imperative listeners, so the imperative implementation is kept wholesale inside a
// useLayoutEffect (done before paint, no flicker).
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { RailEntry } from "./chat-types";
import type { TimerHandle } from "../../store";
import { placeMenu } from "../../shell";
import { t } from "../../i18n";

// Maps rail roles to i18n keys; resolved via t() at popup time (language switch remounts the tree).
const RAIL_ROLE_LABEL: Record<string, string> = { user: "chat.roleUser", assistant: "chat.roleAssistant", thinking: "chat.thinking", tool: "chat.roleTool", meta: "chat.roleSystem", err: "chat.railError", bash: "chat.railCommand", mention: "chat.labelRead" };
const RAIL_SNIPPET_LEN = 280;
const RAIL_W_BASE = 37.5; // default tick length of 37.5 physical screen pixels (horizontal length)
const RAIL_W_PEAK = 2.5; // peak-top multiplier (the line closest to the mouse)
const RAIL_FALLOFF = 24; // Gaussian falloff radius (CSS px): at ~30px spacing, neighbor ≈1.9, next-neighbor ≈1.3

// Module-level rail state (tick elements are fully rebuilt by the effect; references do not follow React renders)
let railPopEl: HTMLDivElement | null = null; // the currently popped message card
let railHovering = false; // while the pointer is near the rail, redraws do not rebuild ticks ("discard on move-away" strategy)
let railLeaveTimer: TimerHandle | undefined; // tick→card gap grace timer
let railSessionId: string | null = null; // session the ticks were drawn for; switching sessions forces rebuild and card dismissal
let railTicks: HTMLDivElement[] = []; // current tick elements (continuous peaks computed per tick from mouse Y vs tick center)
let railTickCY: number[] = []; // tick centers' Y relative to rail top (precomputed on rebuild; zero rect reads on the mousemove hot path)

// Tick width conversion: size units are physical screen pixels (on Retina 1 CSS px = 2 device pixels)
function railBaseW() {
  return RAIL_W_BASE / (window.devicePixelRatio || 1);
}

// Continuous peaks: assign lengths continuously by the distance between the mouse Y and each
// tick center (Gaussian falloff); the peak top = the nearest line brightened.
// No discrete hover state involved — the animation stays naturally continuous when the
// pointer moves through gaps between ticks
function paintRailAt(clientY: number, railTop: number) {
  const base = railBaseW();
  let best = -1;
  let bestD = Infinity;
  railTicks.forEach((t, j) => {
    const d = Math.abs(clientY - (railTop + railTickCY[j]));
    if (d < bestD) {
      bestD = d;
      best = j;
    }
    const f = 1 + (RAIL_W_PEAK - 1) * Math.exp(-((d / RAIL_FALLOFF) ** 2));
    t.style.width = base * f + "px";
  });
  railTicks.forEach((t, j) => t.classList.toggle("on", j === best));
}

function clearRailProfile() {
  const base = railBaseW();
  railTicks.forEach((t) => {
    t.style.width = base + "px";
    t.classList.remove("on");
  });
}

function dismissRailPop() {
  railHovering = false;
  clearTimeout(railLeaveTimer);
  railLeaveTimer = undefined;
  railPopEl?.remove();
  railPopEl = null;
  clearRailProfile(); // retract the peaks while dismissing the card
}

// Pop the card: 8px right of the tick, vertically centered on it, inset 8px inside the
// viewport; fixed coordinates go through placeMenu which divides out zoom
function showRailPop(entry: RailEntry, idx: number, total: number, tick: HTMLDivElement) {
  railHovering = true;
  railPopEl?.remove();
  const pop = document.createElement("div");
  pop.className = "ring-pop rail-pop";
  const head = document.createElement("div");
  head.className = "rp-head";
  const role = document.createElement("b");
  role.className = "rp-role";
  role.textContent = t(RAIL_ROLE_LABEL[entry.role] ?? entry.role);
  const idxEl = document.createElement("span");
  idxEl.className = "rp-idx";
  idxEl.textContent = `${idx + 1} / ${total}`;
  head.append(role, idxEl);
  const body = document.createElement("div");
  body.className = "rp-body";
  let text = (entry.text || "").trim();
  if (text.length > RAIL_SNIPPET_LEN) text = text.slice(0, RAIL_SNIPPET_LEN) + " …";
  body.textContent = text || t("chat.noTextContent");
  pop.append(head, body);
  pop.addEventListener("mouseenter", () => clearTimeout(railLeaveTimer));
  pop.addEventListener("mouseleave", () => dismissRailPop());
  document.body.appendChild(pop);
  railPopEl = pop;
  const r = tick.getBoundingClientRect();
  const top = Math.min(Math.max(r.top + r.height / 2 - pop.offsetHeight / 2, 8), window.innerHeight - pop.offsetHeight - 8);
  placeMenu(pop, r.right + 8, Math.max(8, top));
}

// entries: { key, role, text } (collected along the traversal in items.tsx); each message is located via its data-fk anchor
export default function MsgRail({ entries, sessionId, streamRef }: { entries: RailEntry[]; sessionId: string; streamRef: RefObject<HTMLDivElement | null> }) {
  const railRef = useRef<HTMLDivElement | null>(null);

  // Rebuild ticks: after each message list / layout change (the former buildMsgRail; skipped
  // while hovering, so a redraw does not interrupt the hover state and the running width
  // animations)
  useLayoutEffect(() => {
    const rail = railRef.current;
    const streamEl = streamRef.current;
    if (!rail || !streamEl) return;
    const userEntries = entries.filter((e) => e.role === "user");
    if (sessionId !== railSessionId) {
      railSessionId = sessionId;
      dismissRailPop();
    }
    if (userEntries.length <= 4) {
      // With ≤ 4 user messages the rail line is not shown
      rail.hidden = true;
      rail.innerHTML = "";
      dismissRailPop();
      return;
    }
    rail.hidden = false;
    rail.style.top = streamEl.offsetTop + "px";
    rail.style.height = streamEl.clientHeight + "px";
    if (railHovering) return;
    rail.innerHTML = "";
    railTicks = [];
    railTickCY = [];
    const railH = streamEl.clientHeight;
    const streamTop = streamEl.getBoundingClientRect().top;
    const dpr = window.devicePixelRatio || 1;
    const pitchBase = 30 / dpr; // 30 physical screen pixels between adjacent ticks
    const pitch = userEntries.length > 1 ? Math.min(pitchBase, (railH - 6) / (userEntries.length - 1)) : pitchBase;
    const startTop = Math.max(0, (railH - (userEntries.length - 1) * pitch) / 2); // laid out from the centerline outward
    const baseW = railBaseW();
    const tickH = 3.9 / dpr; // line thickness of 3.9 physical screen pixels (130% of 3)
    userEntries.forEach((en, i) => {
      const anchor = streamEl.querySelector(`[data-fk="${en.key}"]`);
      if (!anchor) return; // anchor not mounted yet (e.g. steer bubble renders late): skip this tick
      const r = anchor.getBoundingClientRect();
      const topDoc = r.top - streamTop + streamEl.scrollTop; // message position within the full text (for click-to-locate)
      const tick = document.createElement("div");
      tick.className = "rail-tick t-" + en.role;
      tick.style.top = startTop + i * pitch + "px";
      tick.style.height = tickH + "px";
      tick.style.borderRadius = tickH + "px"; // capsule ends: radii over half the height get clamped, keeping both ends fully rounded
      tick.style.width = baseW + "px";
      railTickCY.push(startTop + i * pitch + tickH / 2); // center relative to rail top; consumed directly on the mousemove hot path
      let hoverTimer: TimerHandle | undefined; // pop the card only after 150ms of stillness; a quick pass-through does not disturb
      tick.addEventListener("mouseenter", () => {
        railHovering = true; // lock rebuilds: streaming redraws must not destroy ticks, or width animations get interrupted
        clearTimeout(railLeaveTimer); // slid in from a neighboring tick: cancel its card-dismissal grace period
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showRailPop(en, i, userEntries.length, tick), 150);
      });
      tick.addEventListener("mouseleave", (e) => {
        clearTimeout(hoverTimer); // left before dwelling 150ms: no card
        if (railPopEl?.contains(e.relatedTarget as Node | null)) return; // moved straight into the card; its own mouseleave closes it
        clearTimeout(railLeaveTimer);
        railLeaveTimer = setTimeout(() => {
          if (railPopEl && !railPopEl.matches(":hover")) dismissRailPop();
        }, 200);
      });
      tick.addEventListener("click", () => {
        streamEl.scrollTo({ top: Math.max(0, topDoc - streamEl.clientHeight / 2 + r.height / 2), behavior: "smooth" });
      });
      rail.appendChild(tick);
      railTicks.push(tick);
    });
  });

  // Pointer near the rail (including gaps between ticks): lock rebuilds and follow
  // continuously; leaving the rail with no card popped: retract immediately.
  // Runs synchronously (cost = one exponentiation per tick, far cheaper than a reflow), no rAF
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!railTicks.length) return;
      const rail = railRef.current;
      const streamEl = streamRef.current;
      if (!rail || !streamEl || rail.hidden) return;
      const rr = rail.getBoundingClientRect();
      const inside = e.clientX >= rr.left - 6 && e.clientX <= rr.right + 6 && e.clientY >= rr.top - 4 && e.clientY <= rr.bottom + 4;
      if (inside) {
        railHovering = true;
        paintRailAt(e.clientY, rr.top);
      } else if (!railPopEl) {
        railHovering = false;
        clearRailProfile();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      dismissRailPop();
    };
  }, [streamRef]);

  return <div id="msgRail" ref={railRef} hidden />;
}
