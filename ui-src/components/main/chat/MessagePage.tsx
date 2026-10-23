// Chat area: TODO process card (statusWrap) + message stream (stream) + message rail
// (msgRail) + "working Ns" row (WorkSec) + in-session find (⌘F). The streaming status row
// (spinner + dynamic text) lives in ChatLoading.
// Migrated from renderChat in ui/chat.js + the scroll handling of markdown.js:
// - Scroll restore per session: switching back to a session restores the position saved
//   by its last scroll (positions at the bottom restore to the latest content, so resumed
//   at-bottom viewers keep following); a session first loaded into the pool this client
//   runtime opens at the latest content. Records are keyed per client channel
//   (desktop vs remote). When pinned (within 40px of the bottom), any re-render
//   (streaming append / expand body) stays pinned. Bottom proximity is judged in the layout
//   effect from the CURRENT scrollTop (readback is synchronous, so it sees compositor wheel
//   scrolls whose scroll event has not been delivered yet), minus the scrollHeight growth
//   since the last sample — post-render scrollHeight already contains the new content, which
//   would otherwise read as "user scrolled up" and break following for pinned viewers on
//   large single-render growth. A user-initiated scroll additionally arms a 150ms latch
//   (performance.now): while active, programmatic bottom-follows are skipped, so a token
//   landing mid-flick cannot yank the view back down. Only a real gesture counts as one: the
//   stream keeps settling for a frame or two after a switch (late image/highlight sizing,
//   per-session dock/composer mounting) and the browser then moves scrollTop by itself, so
//   scroll events stay attributed to the restore until real input arrives or
//   SWITCH_SETTLE_MS passes. Otherwise that transient offset was both remembered as the
//   session's position and read as a gesture (latch armed), which is what made a resumed
//   session sit at a stale offset instead of the latest content. The
//   target itself is latestScrollTop() — see its comment for why the plain scrollHeight
//   target is wrong.
// - "Scroll to end" button: permanently at the stream's end (the former ensureScrollBottom);
//   visibility toggled imperatively from scroll events; shown only when the latest content
//   sits more than 120px below the viewport (high-frequency scrolling stays out of React state).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, isJunkPlaceholder, send, effZoom } from "../../../store";
import { REMOTE } from "../../../store/layout";
import Icon from "../../../Icon";
import TodoCard from "../../chat/TodoCard";
import { WorkSec } from "../../chat/WorkLine";
import ChatLoading from "../../chat/ChatLoading";
import AssistantMsg from "../../chat/AssistantMsg";
import MsgRail from "../../chat/MsgRail";
import FindBar from "../../chat/FindBar";
import { renderItems } from "../../chat/items";
import type { RailEntry } from "../../chat/chat-types";
import { computeBranchNav, getPendingBranchScroll, clearPendingBranchScroll } from "../../chat/branch-nav";
import { motionEnabled, updateRailVisibility } from "../../../shell";

// Bottom fade reserve: #stream::after (main-composer.css) is a sticky 36px spacer that
// counts as real scrollable height, and the sticky user bubble's own bottom fade is 36px
// (main-chat.css .sticky-user-wrap::after)
const FADE_RESERVE = 36;

// CDS useClaudeScrollPinning tolerances: the stream counts as pinned within 40px of the
// bottom; a user-initiated scroll arms a 150ms latch that blocks programmatic
// bottom-follow (streaming appends), and the "scroll to end" button appears only when the
// latest content is more than 120px below the viewport
const PIN_TOLERANCE = 40;
const FOLLOW_LATCH_MS = 150;
const BTN_SHOW_TOLERANCE = 120;
// How long after a session switch the stream may still be settling (late image/highlight
// sizing, the per-session dock/composer mounting) — scroll events in this window are the
// restore's own and must not be read as gestures.
const SWITCH_SETTLE_MS = 1000;

// Scroll-gesture ownership across wheel-eating overlays. Two mechanisms:
// 1. Inline expand cards (.ed-brief/.chg-body/... inside the stream): while a wheel-driven
//    stream scroll is in progress the stream carries a .wheel-through class that makes the
//    cards pointer-transparent (CSS, main-chat.css) — the wheel passes through to the
//    stream natively, no preventDefault involved, so behavior is identical in every web
//    engine (the desktop shell hosts a WKWebView, whose wheel-cancel semantics differ from
//    Chromium). The class is armed by wheels targeting the stream and expires 1s after the
//    last one; content-growth scrolls (streaming bottom-follow) never arm it, so cards
//    stay scrollable while output streams. Keep the CSS selector in sync with
//    INLINE_CARD_SELECTOR below.
// 2. Floating popups (popcards .ring-pop / menus, portaled outside the stream): a
//    document-capture wheel listener redirects their wheels back to the stream while the
//    scroll gesture is stream-owned. Ownership model: the first wheel after an idle gap
//    longer than GESTURE_IDLE_MS decides the owner by pointer location (stream / popup /
//    other). While a stream-owned gesture continues, popup wheels are redirected —
//    regardless of how the pointer moved onto it and regardless of inter-stroke pauses,
//    because every wheel refreshes the gesture. Only after the whole gesture has been
//    idle for over 1s does the popup receive wheels again (its own scroll + overscroll
//    containment). (Pointer-transparency is not used for popups: flipping pointer-events
//    under a hovering pointer fires pointerout and the ring-pop grace-close logic would
//    dismiss the card, violating the "stop 1s, then scroll the card" contract.)
const GESTURE_IDLE_MS = 1000;
const POPUP_SELECTOR = ".ring-pop, .menu, .ctx-menu";
// Inline expand cards with their own vertical scroll (same list as the bleed-through
// guard in the stream wheel listener and the .wheel-through CSS in main-chat.css; keep
// all three in sync)
const INLINE_CARD_SELECTOR = ".ed-brief, .cmd-card, .bash-out, .think-body, .chg-body, .ro-body, .approval-card, #todoList";
// Message-content scrollers own their wheels when hovered directly (a wheel on them must
// not arm .wheel-through, otherwise the arming tick would flip them pointer-transparent
// and the next tick hijacks the gesture into the stream). Deliberately NOT part of
// INLINE_CARD_SELECTOR: the bleed-through guard would block stream scrolling over their
// short/non-scrollable areas, and code blocks/tables are far too prevalent for that.
// Both selectors ARE part of the .wheel-through CSS transparency list (superset).
const SCROLL_OWNER_SELECTOR = `${INLINE_CARD_SELECTOR}, .md-code-block-frame [data-streamdown="code-block-body"], .sticky-user-wrap .user-msg-text`;

// Per-session scroll restore (survives across sessions because the stream node is reused,
// not remounted): positions saved from scroll events, keyed "<channel>:<activePath>".
// seenPaths tracks sessions whose items rendered at least once this client runtime — an
// unseen session is a fresh pool load and opens at the latest content.
const savedScrollPos = new Map<string, { top: number; max: number }>();
const seenPaths = new Set<string>();
const scrollKey = (path: string) => `${REMOTE ? "r" : "d"}:${path}`;

// "Show the latest" scroll target. The plain scrollHeight target overshoots the newest
// turn by the sticky spacer's height whenever that turn fits the viewport (fresh send /
// short turn), which pins the sticky user bubble 36px above its flow position and drags
// the turn's flow content (Working row, streaming draft) up under the bubble's 36px fade
// mask. Target the newest content's real end + the spacer instead, clamped to the newest
// turn's top: a fitting turn is shown from its top (bubble at the scrollport top, flow
// content clear below it) while a taller turn keeps following its bottom.
function latestScrollTop(el: HTMLElement): number {
  let last = el.lastElementChild as HTMLElement | null;
  while (last && last.classList.contains("scroll-bottom")) last = last.previousElementSibling as HTMLElement | null;
  if (!last) return 0;
  const max = el.scrollHeight - el.clientHeight;
  if (last.classList.contains("turn-section")) {
    // The section itself stretches to the viewport (min-height:100%), so its box end is
    // not the content end; the last child (turn-body / turn-acts) carries it
    const inner = last.lastElementChild as HTMLElement | null;
    const end = last.offsetTop + (inner ? inner.offsetTop + inner.offsetHeight : last.offsetHeight);
    return Math.min(max, Math.max(last.offsetTop, end + FADE_RESERVE - el.clientHeight));
  }
  // Top-level node after the sections (pending steer bubble): keep it above the fade at the
  // stream end; a stream shorter than the viewport just pins to its top
  return Math.min(max, Math.max(0, last.offsetTop + last.offsetHeight + FADE_RESERVE - el.clientHeight));
}

// Button visibility: shown while the latest content sits more than BTN_SHOW_TOLERANCE px
// below the viewport (newer content to jump down to); imperative toggle out of React state

function updateScrollBottomVis(el: HTMLElement | null, btn: HTMLElement | null) {
  if (!el || !btn) return;
  btn.classList.toggle("hidden", latestScrollTop(el) - el.scrollTop <= BTN_SHOW_TOLERANCE);
}

export default function MessagePage() {
  const { t } = useTranslation();
  // Field-level subscriptions (Batch 1): the whole-session selector re-rendered this page on
  // every updateSession of the active session; scalars re-render only when a read field flips.
  // T7: after LRU eviction the getters return undefined/false — same fallbacks as before.
  const hasSession = useAppStore((st) => (st.activePath ? st.openSessions.has(st.activePath) : false));
  const items = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.items : undefined));
  const draft = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.assistantDraft : ""));
  const streaming = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.streaming : false));
  const externalWrite = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.externalWrite ?? false : false));
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const activePath = useAppStore((st) => st.activePath);
  // Branch pager data source (entry-tree slice; fetched below so the pagers work
  // without ever opening the /tree page)
  const entryTree = useAppStore((st) => st.entryTree);
  const streamRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevPath = useRef<string | null>(null);
  const prevItemsLen = useRef(0);
  // scrollHeight at the last follow-check/scroll event, for the growth correction below
  const lastScrollHeight = useRef(0);
  // Switch restore in flight: it wrote its target, but the post-switch layout can still
  // settle (late image/highlight sizing, dock/composer resize load after the commit) and the
  // browser then moves scrollTop on its own. Until a real gesture arrives (or the window
  // expires) scroll events belong to the restore, not to the reader.
  const switching = useRef<{ at: number; toLatest: boolean; sh: number } | null>(null);
  // Reading-position anchor for stream WIDTH reflow (side-panel collapse/expand, gutter
  // drag; the message column is a percentage of #main, so widening the card re-wraps every
  // message and the content above the viewport shrinks by hundreds of px). WKWebView has no
  // CSS scroll anchoring (Chromium-only) — without this the reader's content slides away and
  // the scrollbar thumb jumps. Entry point is sampled on scroll/render, restored per layout.
  const scrollAnchor = useRef<{ el: Element; top: number } | null>(null);
  const sampleAnchor = (el: HTMLElement) => {
    // children are in flow order, so the first one reaching below scrollTop is the first visible
    let first: Element | null = null;
    for (const c of el.children) {
      const h = c as HTMLElement;
      if (h.offsetTop + h.offsetHeight > el.scrollTop) {
        first = c;
        break;
      }
    }
    scrollAnchor.current = first ? { el: first, top: first.getBoundingClientRect().top } : null;
  };
  const restoreAnchor = (el: HTMLElement) => {
    const a = scrollAnchor.current;
    if (!a || !a.el.isConnected) return;
    const delta = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(delta) < 1) return;
    programmaticScroll.current = true;
    el.scrollTop += delta;
  };
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Scroll pin latch (CDS useClaudeScrollPinning): performance.now() of the last
  // USER-initiated scroll; programmatic writes tag themselves so their async scroll event
  // is not misread as a user gesture
  const lastUserScrollAt = useRef(0);
  const programmaticScroll = useRef(false);

  // Programmatic scroll to the latest-content position: always behavior 'auto' (instant) —
  // a smooth follow would visibly trail the streaming append. Tags the write so the scroll
  // event it fires is consumed as programmatic and does not arm the user-scroll latch.
  const scrollToLatest = (el: HTMLElement) => {
    programmaticScroll.current = true;
    el.scrollTop = latestScrollTop(el);
  };

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    const wasProg = programmaticScroll.current;
    if (programmaticScroll.current) programmaticScroll.current = false;
    // Right after a switch the stream is still settling (late image/highlight sizing, the
    // per-session dock/composer mounting) and the browser adjusts scrollTop on its own: those
    // scroll events are the restore's own write and its settles, not gestures. Counting them
    // as gestures armed the follow latch and remembered that transient offset as the
    // session's position — the next visit restored the same wrong offset and never re-pinned.
    const sw = switching.current;
    const inSwitch = sw !== null && performance.now() - sw.at < SWITCH_SETTLE_MS;
    if (!wasProg && !inSwitch) {
      lastUserScrollAt.current = performance.now();
      switching.current = null;
    }
    lastScrollHeight.current = el.scrollHeight;
    updateScrollBottomVis(el, btnRef.current);
    // Record the position for the session currently on screen (getState, not the render
    // closure: the event can outlive the switch that re-rendered this handler)
    const path = useAppStore.getState().activePath;
    if (path && !inSwitch) savedScrollPos.set(scrollKey(path), { top: el.scrollTop, max: el.scrollHeight - el.clientHeight });
    // A switch restore that targeted the latest content measured it before the settle: the
    // old height is not the real bottom anymore, so re-target the settled layout.
    if (inSwitch && sw.toLatest && el.scrollHeight !== sw.sh) {
      scrollToLatest(el);
      sw.sh = el.scrollHeight;
    }
    sampleAnchor(el);

    // Light up the right scrollbar while scrolling, fade out smoothly after it stops
    el.classList.add("scrolling");
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      el.classList.remove("scrolling");
    }, 800);
  };

  // Session switch restores the saved position (first load of a pool session has no
  // record and opens at the latest content) + top on new outgoing message + follow during
  // streaming while pinned (useLayoutEffect finishes before paint, no flash of the old position)
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !items || !activePath) return;
    const switched = prevPath.current !== activePath;
    prevPath.current = activePath;
    const currentLen = items.length;
    const isNewUserMsg = currentLen > prevItemsLen.current && items[currentLen - 1]?.role === "user";
    prevItemsLen.current = currentLen;

    // On session switch restore the position recorded by that session's last scroll:
    // a record taken within PIN_TOLERANCE of the bottom counts as "was following" and
    // re-targets the latest content (which may have grown), everything else restores the
    // saved offset (clamp if the content shrank below it); a session whose items never
    // rendered this runtime is a fresh pool load and opens at the latest content;
    // on a new outgoing message jump to the newest-content position (the last turn's
    // min-height:100% puts the new message right at the top; a turn that fits the viewport
    // top-aligns, so its flow content stays clear of the sticky bubble's fade mask);
    // during streaming, keep following while pinned to the bottom
    const growth = el.scrollHeight - lastScrollHeight.current;
    lastScrollHeight.current = el.scrollHeight;
    // Read the CURRENT scrollTop instead of an event-recorded flag: in WKWebView wheel
    // scrolls apply on the compositor and the scroll event arrives after the next render,
    // so a token landing mid-flick used to read a stale "at bottom" and yank the view back
    // down, erasing the user's upward scroll. Subtract the scrollHeight growth since the
    // last sample: post-render scrollHeight already contains the appended content, which
    // would otherwise read as "user scrolled up" and break following for pinned viewers
    // when a large item lands in a single render.
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight - Math.max(0, growth) < PIN_TOLERANCE;
    // Latch: a user scroll within the last FOLLOW_LATCH_MS blocks the programmatic follow —
    // mid-flick, streaming appends must not steal the gesture. Session switches and fresh
    // outgoing messages are deliberate user navigation and bypass the latch.
    const latchActive = performance.now() - lastUserScrollAt.current < FOLLOW_LATCH_MS;
    if (switched) {
      const saved = seenPaths.has(activePath) ? savedScrollPos.get(scrollKey(activePath)) : undefined;
      if (saved && saved.max - saved.top > PIN_TOLERANCE) {
        programmaticScroll.current = true;
        el.scrollTop = saved.top;
        switching.current = { at: performance.now(), toLatest: false, sh: el.scrollHeight };
      } else {
        scrollToLatest(el);
        switching.current = { at: performance.now(), toLatest: true, sh: el.scrollHeight };
      }
      seenPaths.add(activePath);
    } else if (isNewUserMsg || (pinned && !latchActive)) {
      scrollToLatest(el);
    }
    // Session switch slide: the stream node is reused across sessions (no remount), so the
    // entrance is played imperatively here — 200ms sideways drift, TUI's rewind slide
    // counterpart. Web Animations (not a CSS class) so nothing has to be reset afterwards.
    // motionEnabled() keeps it inside the app's data-motion / OS reduce contract, which CSS
    // rules cannot reach.
    if (switched && motionEnabled()) {
      const css = getComputedStyle(el);
      el.animate([{ opacity: 0, transform: "translateX(8px)" }, { opacity: 1, transform: "none" }], {
        duration: parseFloat(css.getPropertyValue("--dur-base")) || 200,
        easing: css.getPropertyValue("--swift").trim() || "ease-out",
      });
    }
    updateScrollBottomVis(el, btnRef.current);
    sampleAnchor(el);
  }, [items, draft]);

  // Rail visibility init: .dock mounts in the same frame as the chat area, #main's size does
  // not change from inner mounting, so the ResizeObserver does not fire; the dock may not
  // exist yet when initShell sets up its observer (sessions restore async), so compute once
  // proactively on mount here (both startup restore and switching back to a newly created
  // session pass through this remount)
  useLayoutEffect(() => {
    updateRailVisibility();
  }, []);

  // Scrollport resize: two cases share this observer.
  // 1. Phone soft keyboard — the shell shrinks to the visual viewport (--app-h, shell.ts), so
  //    the scrollport resizes under a reader who was following the bottom. Without a re-pin the
  //    newest content slides out of view and the page reads as jumping while typing. Judge
  //    against the PREVIOUS height — by the time the callback runs, the smaller clientHeight
  //    already looks like "scrolled up".
  // 2. WIDTH reflow (side-panel collapse/expand, gutter drag): the column re-wraps and the
  //    content above the viewport changes height, so a reader who is not pinned gets their
  //    place back from the anchor (WKWebView has no scroll anchoring of its own).
  // Keyed on hasSession because the empty-state and session trees render two different #stream nodes.
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const wasPinned = el.scrollHeight - el.scrollTop - lastH < PIN_TOLERANCE;
      lastH = el.clientHeight;
      if (wasPinned) scrollToLatest(el);
      else restoreAnchor(el);
      sampleAnchor(el); // the restore moved the viewport; re-anchor to what is visible now
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasSession]);

  // Branch pager data: the entry tree starts null and is normally only fetched
  // by the /tree page; the chat view needs it for the fork pagers, so refetch
  // whenever it is stale for the active session (mount, and after the
  // turn_end / session_navigated invalidations) — same guards as the tree
  // page's own mount fetch.
  useEffect(() => {
    if (!sessionId) return;
    const st = useAppStore.getState();
    if (st.entryTree?.sessionId === sessionId || st.entryTreePending) return;
    useAppStore.setState({ entryTreePending: true, entryTreeFor: sessionId });
    send({ type: "get_entry_tree", sessionId });
  }, [sessionId, entryTree]);

  // Branch-pager scroll: a pager click records the fork point; the receipt
  // invalidates the tree, the effect above refetches it, and once the new map
  // lands this scrolls to the new branch's host bubble of the SAME fork
  // (data-eid anchor). Rect diff is visual px, scrollTop is layout px inside
  // the zoomed subtree — same conversion as the tree page.
  const branchNav = useMemo(
    () => (entryTree && entryTree.sessionId === sessionId ? computeBranchNav(entryTree.roots ?? [], entryTree.leafId) : null),
    [entryTree, sessionId],
  );
  useLayoutEffect(() => {
    const pend = getPendingBranchScroll();
    if (!pend || useAppStore.getState().entryTreeNav) return;
    if (entryTree === pend.treeRef) {
      clearPendingBranchScroll(); // receipt left the tree untouched → navigation failed
      return;
    }
    if (!entryTree || entryTree.sessionId !== pend.sessionId || !branchNav) return; // refetch still in flight
    clearPendingBranchScroll();
    let hostId: string | null = null;
    for (const [id, info] of branchNav) {
      if (info.forkId === pend.forkId) {
        hostId = id;
        break;
      }
    }
    const stream = streamRef.current;
    const host = hostId ? stream?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(hostId)}"]`) : null;
    if (!stream || !host) return; // fork has no visible host bubble on the new branch → no scroll
    programmaticScroll.current = true;
    stream.scrollTop += (host.getBoundingClientRect().top - stream.getBoundingClientRect().top - 12) / effZoom();
  }, [entryTree, branchNav, items]);

  useEffect(() => () => clearTimeout(scrollTimer.current), []);

  // Any real input ends the post-switch settle window (see switching): the stream's own
  // settles never come with one, so a gesture inside that window must not be swallowed.
  useEffect(() => {
    const end = () => {
      switching.current = null;
    };
    const types = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of types) document.addEventListener(type, end, { capture: true, passive: true });
    return () => {
      for (const type of types) document.removeEventListener(type, end, { capture: true });
    };
  }, []);

  // Block scroll bleed-through from tab popups / inline expand cards into the outer message
  // stream (no chained propagation outward at the boundary).
  // Document-level capture with a lazy streamRef read: at mount the session is usually not
  // restored yet, so the first render is the empty-state tree whose #stream node gets
  // REPLACED when the real tree mounts — a node captured here (or a listener attached to it)
  // would dangle on the detached node forever.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const stream = streamRef.current;
      if (!stream || !stream.contains(target)) return;
      const card = target.closest<HTMLElement>(INLINE_CARD_SELECTOR);
      if (card) {
        // Find the innermost vertically scrollable container containing the current trigger point
        let scroller: HTMLElement | null = target;
        while (scroller && scroller !== card) {
          const style = window.getComputedStyle(scroller);
          const oy = style.overflowY;
          if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) {
            break;
          }
          scroller = scroller.parentElement;
        }
        if (!scroller || scroller === card) {
          const style = window.getComputedStyle(card);
          const oy = style.overflowY;
          if ((oy === "auto" || oy === "scroll") && card.scrollHeight > card.clientHeight) {
            scroller = card;
          } else {
            scroller = null;
          }
        }

        // The card's current area is not vertically scrollable: fully block the wheel event
        // from bleeding through and dragging the outer message stream
        if (!scroller) {
          e.preventDefault();
          return;
        }

        // Check scroll boundaries: when continuing up at the top or down at the bottom,
        // prevent the default behavior (no upward bleed-through)
        const { scrollTop, scrollHeight, clientHeight } = scroller;
        const delta = e.deltaY;
        if (delta > 0 && scrollTop + clientHeight >= scrollHeight - 1) {
          e.preventDefault();
          return;
        } else if (delta < 0 && scrollTop <= 0) {
          e.preventDefault();
          return;
        }
      }
    };

    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  // Swallow the select-all shortcut over the message stream: Cmd/Ctrl+A there would
  // select the whole shell UI around it, not just messages. The keydown target is BODY
  // (message text is not focusable), so the owner is resolved from the selection anchor
  // instead. Inputs inside the stream (approval forms) keep the native behavior. Same
  // document-level capture + lazy streamRef read as the wheel blocker above (#stream
  // gets replaced at session restore).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== "a" && e.key !== "A")) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("input, textarea, [contenteditable]")) return;
      const stream = streamRef.current;
      if (!stream) return;
      const sel = window.getSelection();
      if (
        !stream.contains(target) &&
        !(sel?.anchorNode && stream.contains(sel.anchorNode)) &&
        !(sel?.focusNode && stream.contains(sel.focusNode))
      ) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // Scroll-gesture ownership (see the module-level comment): arm .wheel-through on
  // wheel-driven stream scrolls (inline expand cards become pointer-transparent via CSS)
  // and redirect stream-owned gesture wheels on floating popups back to the stream
  const gestureOwner = useRef<"stream" | "popup" | "other">("other");
  const lastWheelAt = useRef(0);
  const wheelThroughTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const armWheelThrough = (stream: HTMLElement) => {
      stream.classList.add("wheel-through");
      clearTimeout(wheelThroughTimer.current);
      wheelThroughTimer.current = setTimeout(() => stream.classList.remove("wheel-through"), GESTURE_IDLE_MS);
    };
    const onWheelCapture = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Lazy read: the #stream node at effect time may belong to the empty-state tree and
      // be replaced once the session restores (see the bleed/snap effect comment above)
      const stream = streamRef.current;
      if (!stream) return;
      const inStream = stream.contains(target);
      const inPopup = !inStream && !!target.closest(POPUP_SELECTOR);
      const now = Date.now();
      // First wheel after the idle gap decides the owner by pointer location
      if (now - lastWheelAt.current > GESTURE_IDLE_MS) {
        gestureOwner.current = inStream ? "stream" : inPopup ? "popup" : "other";
      }
      lastWheelAt.current = now;
      if (gestureOwner.current === "stream" && inPopup) {
        e.preventDefault();
        e.stopPropagation();
        stream.scrollTop += e.deltaY;
        armWheelThrough(stream);
      } else if (inStream && !inPopup && !target.closest(SCROLL_OWNER_SELECTOR)) {
        // A wheel on the plain stream surface (or on non-owning content like tables):
        // a wheel-driven scroll is in progress
        armWheelThrough(stream);
      }
    };

    // Card scroll capture: light up scrollbars while an inner card scroll container is scrolling.
    // Covers cards anywhere in the shell (the dock's approval card lives outside #stream).
    const cardScrollTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const onScrollCapture = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.classList) return;
      const stream = streamRef.current;
      if (stream && target === stream) return; // #stream lights its own scrollbar in the stream scroll listener
      const card = target.closest<HTMLElement>(INLINE_CARD_SELECTOR);
      if (!card) return;
      target.classList.add("scrolling");
      if (card && card !== target) card.classList.add("scrolling");
      const existing = cardScrollTimers.get(target);
      if (existing) clearTimeout(existing);
      cardScrollTimers.set(
        target,
        setTimeout(() => {
          target.classList.remove("scrolling");
          if (card && card !== target) card.classList.remove("scrolling");
          cardScrollTimers.delete(target);
        }, 500),
      );
    };

    document.addEventListener("wheel", onWheelCapture, { passive: false, capture: true });
    document.addEventListener("scroll", onScrollCapture, { passive: true, capture: true });
    return () => {
      document.removeEventListener("wheel", onWheelCapture, { capture: true });
      document.removeEventListener("scroll", onScrollCapture, { capture: true });
      clearTimeout(wheelThroughTimer.current);
      for (const t of cardScrollTimers.values()) clearTimeout(t);
      cardScrollTimers.clear();
    };
  }, []);

  // Scroll-to-end button (permanently last; visibility driven by the scroll listener)
  const scrollBottomBtn = (
    <button
      id="scrollBottom"
      className="scroll-bottom hidden"
      type="button"
      title={t("chat.scrollBottomTitle")}
      ref={btnRef}
      onClick={() => {
        const el = streamRef.current;
        if (el) scrollToLatest(el); // instant (behavior 'auto'); re-arms bottom-follow
      }}
    >
      <Icon name="down" />
    </button>
  );

  // Concise style's live view (ui.prefs.agentProcessStyle === "concise"): while the turn
  // runs only the working row, the spinner+intent and the assistant outputs stay on
  // screen; liveStart is that turn's user row, liveProcess tells whether there is a
  // process to reveal behind the working row's chevron. Finished turns and the post-turn
  // layout are untouched, so the toggle state resets per turn (and per session).
  const turnStartAt = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.turnStartAt : null));
  const processStyle = useAppStore((st) => st.uiPrefs.agentProcessStyle);
  const [conciseOpen, setConciseOpen] = useState(false);
  useEffect(() => {
    setConciseOpen(false);
  }, [sessionId, turnStartAt]);
  const conciseLive = processStyle === "concise" && streaming;
  const list = items ?? [];
  let liveStart = -1;
  let liveProcess = false;
  if (conciseLive) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "user") {
        liveStart = i;
        break;
      }
    }
    for (let i = liveStart + 1; i < list.length && !liveProcess; i++) liveProcess = list[i].role !== "assistant";
  }
  const hideProcessFrom = conciseLive && !conciseOpen && liveStart >= 0 ? liveStart : undefined;

  const streamTail =
    streaming || draft ? (
      <>
        <WorkSec
          onToggle={liveProcess ? () => setConciseOpen((v) => !v) : undefined}
          open={conciseOpen}
        />
        {/* Streaming tail renders as markdown through AssistantMsg/MdSurface (streamdown):
            the engine memoizes per block, so appending to the growing draft only re-parses
            the last incomplete block — NOT the full-text-per-frame re-parse that froze the
            app in BUG-007 round 3 (that was the old custom pipeline, pre-streamdown). */}
        {draft && !isJunkPlaceholder(draft) && (
          <AssistantMsg text={draft} streaming />
        )}
        {streaming && <ChatLoading />}
      </>
    ) : null;
  // Message rail data + row elements in one memo (Batch 2): renderItems fills the rail
  // entries as a side effect of the traversal, so both come from the same pass; the memo
  // keys on items/draft/streamTail (streamTail covers the streaming flip) and the row
  // components further below compare scalar props, so a 100ms delta flush re-renders only
  // the rows whose own data changed. Runs before the no-session early return (hooks must
  // stay unconditional); with no session items is undefined and the pass is trivially empty.
  // processStyle is a dep of its own: renderItems reads the fold style from the store
  // (non-reactive), so the subscription is what re-lays out messages when it changes.
  const { nodes, railEntries } = useMemo(() => {
    const entries: RailEntry[] = [];
    const out = renderItems(items ?? [], "", entries, streamTail, { hideProcessFrom, branchNav });
    return { nodes: out, railEntries: entries };
  }, [items, draft, streamTail, processStyle, hideProcessFrom, branchNav]);

  if (!hasSession) {
    return (
      <>
        <div id="statusWrap" />
        <div id="stream" ref={streamRef} onScroll={onScroll}>
          <div className="text-faint text-ui-base py-[12px] px-[10px]">{t("chat.emptyHint")}</div>
          {scrollBottomBtn}
        </div>
      </>
    );
  }
  return (
    <>
      <TodoCard />
      {/* External-process write notice bar: set by the host's session_external_write frame;
          cleared when a reload rebuilds from disk */}
      {externalWrite && (
        <div className="extw-bar">
          <Icon name="info" />
          <span className="extw-tx">{t("chat.externalWriteNotice")}</span>
          {/* While this session itself is generating, a rebuild is refused host-side (it would
              orphan the running turn); disable it here too so the click is not a dead end.
              The live view keeps streaming, so nothing needs reloading mid-turn. */}
          <button
            type="button"
            className="save-btn"
            disabled={streaming}
            title={streaming ? t("chat.reloadRunning") : undefined}
            onClick={() => send({ type: "reload_session", path: activePath })}
          >
            {t("chat.reload")}
          </button>
        </div>
      )}
      <div id="stream" ref={streamRef} onScroll={onScroll}>
        {nodes}
        {nodes.length === 0 && streamTail}
        {scrollBottomBtn}
      </div>
      <MsgRail entries={railEntries} sessionId={sessionId ?? ""} streamRef={streamRef} />
      <FindBar streamRef={streamRef} />
    </>
  );
}
