// Message rail: the vertical tick bar on the left of the main chat area, one tick per user
// message; whichever tick the pointer's Gaussian peak currently lands on is the one that
// shows its message card (popped 150ms after the peak settles, so passing through stays quiet).
// Independently of the pointer, the user message currently pinned at the stream top keeps
// its own tick lit (paintRailPins); the width mountain stays pointer-driven.
// Migrated from buildMsgRail/paintRailAt/showRailPop in ui/ringpop.js — tick positioning
// relies on getBoundingClientRect measuring the actual layout, and the interactions
// (mousemove continuous peaks / peak grace-period popcard / click-to-scroll) rely on
// imperative listeners, so the imperative implementation is kept wholesale inside a
// useLayoutEffect (done before paint, no flicker).
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import type { RailEntry } from "./chat-types";
import type { TimerHandle } from "../../store";
import { placeMenu } from "../../shell";
import { useAppStore } from "../../store";
import { onSpectrum, SPECTRUM_BANDS } from "./railAudio";
import { t } from "../../i18n";

// Maps rail roles to i18n keys; resolved via t() at popup time (language switch remounts the tree).
const RAIL_ROLE_LABEL: Record<string, string> = { user: "chat.roleUser", assistant: "chat.roleAssistant", thinking: "chat.thinking", tool: "chat.roleTool", meta: "chat.roleSystem", err: "chat.railError", bash: "chat.railCommand", mention: "chat.labelRead" };
const RAIL_SNIPPET_LEN = 280;
const RAIL_W_BASE = 12.5; // default tick length in CSS px (the UI zoom multiplies it along with everything else: #main carries the zoom)
const RAIL_W_PEAK = 2.5; // peak-top multiplier (the line closest to the mouse)
const RAIL_FALLOFF = 24; // Gaussian falloff radius (CSS px): at ~11.25px spacing, neighbor ≈1.9, next-neighbor ≈1.3

// Module-level rail state (tick elements are fully rebuilt by the effect; references do not follow React renders)
let railPopEl: HTMLDivElement | null = null; // the currently popped message card
let railHovering = false; // while the pointer is near the rail, redraws do not rebuild ticks ("discard on move-away" strategy)
let railLeaveTimer: TimerHandle | undefined; // rail→card gap grace timer
let railPopTimer: TimerHandle | undefined; // peak dwell timer (pop only after the peak stays put for 150ms)
let railPopIdx = -1; // tick index owning the popped / pending card
let railTotal = 0; // total tick count (denominator of the card's "n / total")
let railSessionId: string | null = null; // session the ticks were drawn for; switching sessions forces rebuild and card dismissal
let railTicks: HTMLDivElement[] = []; // current tick elements (continuous peaks computed per tick from mouse Y vs tick center)
let railTickCY: number[] = []; // tick centers' Y relative to rail top (precomputed on rebuild; zero rect reads on the mousemove hot path)
let railSpan = { top: 0, bottom: 0 }; // Y band the ticks actually occupy (rail-relative); outside it the pointer counts as away
let railPitch = 0; // vertical spacing between ticks, also the hover slop at each end
interface RailTickMeta { entry: RailEntry; idx: number; tick: HTMLDivElement; pinEl: Element; topDoc: number }
let railTickMeta: RailTickMeta[] = []; // per-tick card payload, index-aligned with railTicks (anchors not yet mounted are skipped on both)
let railSig: string | null = null; // user-message keys + scrollport height of the last rebuild; equal → ticks are still geometrically valid

// Tick sizes are plain CSS px, same as the rest of the UI. They used to be defined in
// physical screen pixels (value / devicePixelRatio), which kept the physical thickness
// constant across displays but doubled the rail's size relative to the UI on 1x displays
// (fonts don't scale with dpr); the values below are the old Retina (dpr=2) rendering.

// Single writer for tick widths: the music term when a capture is running, the
// pointer's Gaussian term otherwise. Both live in parallel arrays so either
// input can change without the other recomputing from scratch.
// While music drives the rail the pointer only brightens the nearest tick
// (.on) and pops its card — driving widths too made the two fight, and the
// music froze the moment the pointer parked anywhere near the rail.
const RAIL_W_MUSIC = 2.2; // extra length multiplier at full band energy (bass at the rail's top, treble at the bottom)
// Measured band energy hovers around 0.6 on typical music and only dips near 0.15
// in quiet passages, so feeding it raw left every tick permanently near its max.
// Subtracting this floor remaps the useful range onto 0..1: quiet passages fall
// back to the resting length, hits reach the full stretch.
const RAIL_MUSIC_FLOOR = 0.32;
// A capture keeps streaming frames while nothing is playing (normalized bands sit at
// zero: the Rust analyzer subtracts its noise floor). Below this the stream carries
// silence, not music — the pointer must keep owning the widths, or the rail freezes
// flat and the hover mountain never appears.
const RAIL_MUSIC_SILENT = 0.02;
let railGain = new Float32Array(0); // per-tick pointer gain (1 = untouched)
let railMusicGain = new Float32Array(0); // per-tick band energy, floor-remapped to 0..1
let railMusicActive = false; // a capture is streaming frames

function paintRailWidths() {
  const base = RAIL_W_BASE;
  if (railMusicActive) {
    railTicks.forEach((t, j) => {
      t.style.width = base * (1 + RAIL_W_MUSIC * railMusicGain[j]) + "px";
    });
    return;
  }
  railTicks.forEach((t, j) => {
    t.style.width = base * railGain[j] + "px";
  });
}

// Continuous peaks: resolve the nearest tick (Gaussian falloff decides which
// one, but the falloff itself is only drawn when music is NOT driving the
// rail — see paintRailWidths). The peak top is the nearest line brightened and
// owns the card.
function paintRailAt(clientY: number, railTop: number) {
  let best = -1;
  let bestD = Infinity;
  const z = useAppStore.getState().zoomLevel || 1;
  // clientY/railTop are visual; railTickCY lives in the rail's layout px: convert before comparing
  const yLocal = (clientY - railTop) / z;
  railTicks.forEach((_, j) => {
    const d = Math.abs(yLocal - railTickCY[j]);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
    if (railMusicActive) return;
    railGain[j] = 1 + (RAIL_W_PEAK - 1) * Math.exp(-((d / RAIL_FALLOFF) ** 2));
  });
  if (!railMusicActive) paintRailWidths();
  aimRailPopAt(best);
}

// The peak tick owns the card — no pointer needs to sit on a 3px line: the tick the Gaussian
// peak currently lands on is the one that shows its message. A peak switch drops the previous
// card and restarts the 150ms dwell (passing through the rail never pops); staying on one peak
// leaves its card alone.
function aimRailPopAt(best: number) {
  if (best < 0 || best === railPopIdx) return;
  railPopIdx = best;
  clearTimeout(railPopTimer);
  railPopTimer = undefined;
  removeRailCard();
  const meta = railTickMeta[best];
  if (!meta) return;
  railPopTimer = setTimeout(() => {
    railPopTimer = undefined;
    showRailPop(meta.entry, meta.idx, railTotal, meta.tick);
  }, 150);
}

// Pin highlight: while scrolling, the user message currently pinned at the stream top
// (.sticky-user-wrap, position:sticky top:0) keeps its tick lit (.pin) — highlight only;
// the width mountain stays pointer-driven (paintRailAt), and when the pinned message is
// itself under the pointer the mountain simply forms on the lit tick.
function paintRailPins(streamEl: HTMLDivElement) {
  if (!railTicks.length) return; // rail hidden (≤4 user messages) also clears railTicks
  const line = streamEl.getBoundingClientRect().top; // pin line = scrollport top edge (sticky top:0)
  let pin = -1;
  railTickMeta.forEach((m, i) => {
    const el = m.pinEl;
    if (!el.isConnected) return; // stale after a DOM rebuild: never pin on a detached node
    if (el.getBoundingClientRect().top - line <= 2) pin = i; // last anchor at/above the line owns the pin
  });
  railTicks.forEach((t, j) => t.classList.toggle("pin", j === pin));
}

function clearRailProfile() {
  railGain.fill(1);
  paintRailWidths();
}

function removeRailCard() {
  railPopEl?.remove();
  railPopEl = null;
}

function dismissRailPop() {
  railHovering = false;
  clearTimeout(railLeaveTimer);
  clearTimeout(railPopTimer);
  railLeaveTimer = undefined;
  railPopTimer = undefined;
  railPopIdx = -1;
  removeRailCard();
  clearRailProfile(); // retract the peaks while dismissing the card
}

// Pop the card: 8px right of the tick, vertically centered on it, inset 8px inside the
// viewport; fixed coordinates go through placeMenu which divides out zoom
function showRailPop(entry: RailEntry, idx: number, total: number, tick: HTMLDivElement) {
  railHovering = true;
  removeRailCard();
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
  placeMenu(pop, 0, 0); // apply zoom first so the rect below reads visual (zoomed) size
  const pr = pop.getBoundingClientRect();
  const top = Math.min(Math.max(r.top + r.height / 2 - pr.height / 2, 8), window.innerHeight - pr.height - 8);
  placeMenu(pop, r.right + 8, Math.max(8, top));
}

// entries: { key, role, text } (collected along the traversal in items.tsx); each message is located via its data-fk anchor
export default function MsgRail({ entries, sessionId, streamRef }: { entries: RailEntry[]; sessionId: string; streamRef: RefObject<HTMLDivElement | null> }) {
  const railRef = useRef<HTMLDivElement | null>(null);

  // Click: send the message whose pop card is showing (the pointer's peak tick) to the
  // top of the stream, where its sticky wrap pins it. The peak tick — not the raw DOM
  // hit — owns the target: adjacent hit pads overlap, so the element under the pointer
  // is ambiguous. Falls back to the Y-nearest tick when no peak is armed yet.
  const onRailClick = (e: ReactMouseEvent) => {
    const streamEl = streamRef.current;
    const rail = railRef.current;
    if (!streamEl || !rail || rail.hidden) return;
    let idx = railPopIdx;
    if (idx < 0 || !railTicks[idx]?.isConnected) {
      const rr = rail.getBoundingClientRect();
      const yLocal = (e.clientY - rr.top) / (useAppStore.getState().zoomLevel || 1);
      idx = -1;
      let bestD = Infinity;
      railTickCY.forEach((cy, i) => {
        const d = Math.abs(cy - yLocal);
        if (d < bestD) { bestD = d; idx = i; }
      });
    }
    const m = railTickMeta[idx];
    if (!m || !m.tick.isConnected) return;
    streamEl.scrollTo({ top: Math.max(0, m.topDoc), behavior: "smooth" });
  };

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
      railTicks = [];
      railTickMeta = [];
      railGain = new Float32Array(0);
      railMusicGain = new Float32Array(0);
      railSpan = { top: 0, bottom: 0 };
      railPitch = 0;
      railSig = null;
      dismissRailPop();
      return;
    }
    rail.hidden = false;
    rail.style.top = streamEl.offsetTop + "px";
    rail.style.height = streamEl.clientHeight + "px";
    if (railHovering) return;
    // Rebuild skip: streaming redraws re-run this effect many times a second while the
    // user-message set is unchanged; wiping and recreating the tick nodes each time
    // invalidates the rail's composited layer and makes the lit pin tick blink. Same
    // keys + same scrollport height → same tick geometry: keep the nodes, only refresh
    // the click-to-scroll offsets (they drift as streamed content grows above).
    const sig = userEntries.map((e) => e.key).join(",") + "|" + streamEl.clientHeight;
    if (sig === railSig && railTicks.length) {
      const zs = useAppStore.getState().zoomLevel || 1;
      const streamTopNow = streamEl.getBoundingClientRect().top;
      railTickMeta.forEach((m) => {
        const anchor = streamEl.querySelector(`[data-fk="${m.entry.key}"]`);
        if (!anchor) return;
        const pinEl = anchor.closest(".sticky-user-wrap") ?? anchor;
        const pr = pinEl.getBoundingClientRect();
        m.topDoc = (pr.top - streamTopNow) / zs + streamEl.scrollTop;
      });
      return;
    }
    railSig = sig;
    rail.innerHTML = "";
    railTicks = [];
    railTickCY = [];
    railTickMeta = [];
    railGain = new Float32Array(userEntries.length).fill(1);
    railMusicGain = new Float32Array(userEntries.length);
    railTotal = userEntries.length;
    const railH = streamEl.clientHeight;
    const streamTop = streamEl.getBoundingClientRect().top;
    const z = useAppStore.getState().zoomLevel || 1; // rect diffs below are visual; scrollTop/scrollTo are layout px
    const pitchBase = 11.25; // CSS px between adjacent ticks (15 reduced by 1/4)
    const pitch = userEntries.length > 1 ? Math.min(pitchBase, (railH - 6) / (userEntries.length - 1)) : pitchBase;
    const startTop = Math.max(0, (railH - (userEntries.length - 1) * pitch) / 2); // laid out from the centerline outward
    // Ticks are centred in a much taller rail, so the dead space above and
    // below them must not count as hover: without this the pointer anywhere in
    // the column — including the far corners — armed the first/last card.
    railSpan = { top: startTop - pitch / 2, bottom: startTop + (userEntries.length - 1) * pitch + pitch / 2 };
    railPitch = pitch / 2; // half a gap of slop past each end: forgiving without reaching the corners
    const tickH = 1.95; // CSS px line thickness (130% of a 1.5px hairline)
    userEntries.forEach((en, i) => {
      const anchor = streamEl.querySelector(`[data-fk="${en.key}"]`);
      if (!anchor) return; // anchor not mounted yet (e.g. steer bubble renders late): skip this tick
      const r = anchor.getBoundingClientRect();
      const pinEl = anchor.closest(".sticky-user-wrap") ?? anchor;
      const pr = pinEl.getBoundingClientRect();
      // message position within the full text; measured on the sticky wrap so a
      // click lands it exactly at the scrollport top (the anchor sits lower inside it)
      const topDoc = (pr.top - streamTop) / z + streamEl.scrollTop;
      const tick = document.createElement("div");
      tick.className = "rail-tick t-" + en.role;
      tick.style.top = startTop + i * pitch + "px";
      tick.style.height = tickH + "px";
      tick.style.borderRadius = tickH + "px"; // capsule ends: radii over half the height get clamped, keeping both ends fully rounded
      tick.style.width = RAIL_W_BASE + "px";
      railTickCY.push(startTop + i * pitch + tickH / 2); // center relative to rail top; consumed directly on the mousemove hot path
      // Card payloads live on the module-level list (index-aligned with railTicks) because the
      // peak tick — not a hovered one — decides which card shows; the rail-level click handler
      // scrolls the peak's message. pinEl is the sticky wrap (the element that actually pins
      // at the scrollport top); messages without one (e.g. bash bubbles) fall back to the anchor.
      railTickMeta.push({ entry: en, idx: i, tick, pinEl: anchor.closest(".sticky-user-wrap") ?? anchor, topDoc });
      rail.appendChild(tick);
      railTicks.push(tick);
    });
    paintRailPins(streamEl); // initial pin state (restored scroll position arrives without a scroll event)
  });

  // Pointer near the rail (including gaps between ticks): lock rebuilds and follow
  // continuously; the peak tick owns the card. Leaving the rail retracts the peaks; a card
  // still on screen gets a 200ms grace period so sliding into it keeps it alive.
  // Runs synchronously (cost = one exponentiation per tick, far cheaper than a reflow), no rAF
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!railTicks.length) return;
      const rail = railRef.current;
      const streamEl = streamRef.current;
      if (!rail || !streamEl || rail.hidden) return;
      const rr = rail.getBoundingClientRect();
      const z = useAppStore.getState().zoomLevel || 1;
      // Horizontal: the rail column itself (a small slop for slanted pointers).
      // Vertical: only the band the ticks actually occupy — the rail box spans
      // the whole stream height, so trusting it made the empty corners above and
      // below the ticks arm the nearest (i.e. always the first or last) message.
      // e.clientY/rr are visual; railSpan/railPitch are layout px: convert once.
      const yLocal = (e.clientY - rr.top) / z;
      const inside =
        e.clientX >= rr.left - 6 &&
        e.clientX <= rr.right + 6 &&
        yLocal >= railSpan.top - railPitch &&
        yLocal <= railSpan.bottom + railPitch;
      if (inside) {
        railHovering = true;
        clearTimeout(railLeaveTimer); // slid back in from the card gap: cancel the dismissal grace period
        paintRailAt(e.clientY, rr.top); // resolves the peak tick, which then owns the card
        return;
      }
      clearRailProfile();
      if (railPopEl) {
        railHovering = true; // card still up: keep rebuilds locked until it dismisses (mirrors the former hover lock)
        clearTimeout(railLeaveTimer);
        railLeaveTimer = setTimeout(() => {
          if (railPopEl && !railPopEl.matches(":hover")) dismissRailPop();
        }, 200);
      } else {
        railHovering = false;
        clearTimeout(railPopTimer); // left before the peak dwelled 150ms: no card
        railPopTimer = undefined;
        railPopIdx = -1; // next peak entry re-arms
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      dismissRailPop();
    };
  }, [streamRef]);

  // Pin tracking: repaint the pin peak on stream scroll (rAF-coalesced; the per-frame
  // cost is one rect read per tick, reads only — width writes happen at the end of
  // paintRailPins, so no layout thrash within a frame)
  useEffect(() => {
    const streamEl = streamRef.current;
    if (!streamEl) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paintRailPins(streamEl);
      });
    };
    streamEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      streamEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [streamRef]);

  // Music-reactive ticks: each tick takes the energy of its own slice of the
  // spectrum (band 0 = bass at the rail's top, the top bands = treble). The feed
  // is off by default and the settings pref owns the capture lifecycle
  // (railAudio.syncAudioToPref); railAudio already republishes once per
  // animation frame, so this callback paints directly and simply stands down
  // while the pointer owns the widths.
  useEffect(() => {
    const off = onSpectrum(({ bands, active }) => {
      const n = railMusicGain.length;
      if (!n) return;
      let loudest = 0;
      for (const v of bands) if (v > loudest) loudest = v;
      // Silence downgrades to pointer-driven: a running capture is not the same as
      // audible music (WASAPI/ScreenCaptureKit keep emitting zero-energy frames).
      railMusicActive = active && loudest > RAIL_MUSIC_SILENT;
      // Bass-heavy mapping: the low spectrum carries most musical energy, so
      // the upper ticks read from the upper bands of a compressed range.
      for (let j = 0; j < n; j++) {
        const band = Math.floor((j / n) * SPECTRUM_BANDS * 0.75);
        const energy = bands[Math.min(SPECTRUM_BANDS - 1, band)];
        railMusicGain[j] = Math.min(1, Math.max(0, (energy - RAIL_MUSIC_FLOOR) / (1 - RAIL_MUSIC_FLOOR)));
      }
      // Unconditional: the music owns the widths even while the pointer is
      // parked on the rail (it only brightens the nearest tick there).
      paintRailWidths();
    });
    return () => {
      off();
      // Hand the widths back to the pointer on unmount; leaving the flag set
      // would keep every later mouse pass highlight-only with no music left.
      railMusicActive = false;
      railMusicGain = new Float32Array(0);
      railGain = new Float32Array(0);
    };
  }, []);

  return <div id="msgRail" ref={railRef} hidden onClick={onRailClick} />;
}
