// Chat area: TODO process card (statusWrap) + message stream (stream) + message rail
// (msgRail) + "working Ns" row (WorkSec) + in-session find (⌘F). The streaming status row
// (spinner + dynamic text) lives in ChatLoading.
// Migrated from renderChat in ui/chat.js + the scroll handling of markdown.js:
// - Scroll following (stickBottom semantics): switching sessions jumps to the latest
//   content; when glued to the bottom, any re-render (streaming append / expand body)
//   stays pinned. The at-bottom check must happen before the DOM update — use the
//   pre-render state recorded continuously by the scroll listener; after rendering,
//   scrollHeight has already changed and cannot be inferred backwards (120px tolerance as
//   in the original). The target itself is latestScrollTop() — see its comment for why the
//   plain scrollHeight target is wrong.
// - "Scroll to end" button: permanently at the stream's end (the former ensureScrollBottom);
//   visibility toggled imperatively from scroll events (4px tolerance against subpixel
//   jitter; high-frequency scrolling stays out of React state).
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, isJunkPlaceholder, send } from "../store";
import Icon from "../Icon";
import TodoCard from "./chat/TodoCard";
import { WorkSec } from "./chat/WorkLine";
import ChatLoading from "./chat/ChatLoading";
import MsgRail from "./chat/MsgRail";
import FindBar from "./chat/FindBar";
import { renderItems } from "./chat/items";
import type { RailEntry } from "./chat/chat-types";
import { updateRailVisibility } from "../shell";
import MainSessionTree from "./chat/MainSessionTree";
import AgentHub from "./chat/AgentHub";

// Bottom fade reserve: #stream::after (main-composer.css) is a sticky 36px spacer that
// counts as real scrollable height, and the sticky user bubble's own bottom fade is 36px
// (main-chat.css .sticky-user-wrap::after)
const FADE_RESERVE = 36;

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
const INLINE_CARD_SELECTOR = ".ed-brief, .cmd-card, .bash-out, .think-body, .chg-body, .approval-card, #todoList";
// Message-content scrollers own their wheels when hovered directly (a wheel on them must
// not arm .wheel-through, otherwise the arming tick would flip them pointer-transparent
// and the next tick hijacks the gesture into the stream). Deliberately NOT part of
// INLINE_CARD_SELECTOR: the bleed-through guard would block stream scrolling over their
// short/non-scrollable areas, and code blocks/tables are far too prevalent for that.
// Both selectors ARE part of the .wheel-through CSS transparency list (superset).
const SCROLL_OWNER_SELECTOR = `${INLINE_CARD_SELECTOR}, .md-code-block-frame [data-streamdown="code-block-body"], .sticky-user-wrap .user-msg-text`;

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

// Button visibility: shown while the view sits above the latest-content position (newer
// content to jump down to); 4px tolerance against subpixel jitter, imperative toggle out
// of React state
function updateScrollBottomVis(el: HTMLElement | null, btn: HTMLElement | null) {
  if (!el || !btn) return;
  btn.classList.toggle("hidden", el.scrollTop >= latestScrollTop(el) - 4);
}

export default function Chat() {
  const { t } = useTranslation();
  // Current session subscription: all session writes go through updateSession swapping the
  // reference (items/draft/streaming changes re-render)
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const activePath = useAppStore((st) => st.activePath);
  const mainViewMode = useAppStore((st) => st.mainViewMode);
  const hubOpen = useAppStore((st) => st.hubOpen);
  const streamRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevPath = useRef<string | null>(null);
  const prevItemsLen = useRef(0);
  const atBottom = useRef(true); // pre-render at-bottom state (recorded continuously by the scroll listener)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    updateScrollBottomVis(el, btnRef.current);

    // Light up the right scrollbar while scrolling, fade out smoothly after it stops
    el.classList.add("scrolling");
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      el.classList.remove("scrolling");
    }, 800);
  };

  // Force bottom on session switch + top on new outgoing message + follow during streaming
  // when near the bottom (useLayoutEffect finishes before paint, no flash of the old position)
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !s) return;
    const switched = prevPath.current !== activePath;
    prevPath.current = activePath;
    const currentLen = s.items.length;
    const isNewUserMsg = currentLen > prevItemsLen.current && s.items[currentLen - 1]?.role === "user";
    prevItemsLen.current = currentLen;

    // On session switch the stream node is reused, and the old session's scrollTop is
    // meaningless for the new one;
    // on a new outgoing message jump to the newest-content position (the last turn's
    // min-height:100% puts the new message right at the top; a turn that fits the viewport
    // top-aligns, so its flow content stays clear of the sticky bubble's fade mask);
    // during streaming, keep following while glued to the bottom
    if (switched || isNewUserMsg || atBottom.current) {
      el.scrollTop = latestScrollTop(el);
      atBottom.current = true; // the scroll event fires async; settle synchronously first to prevent a same-frame re-render bounce
    }
    updateScrollBottomVis(el, btnRef.current);
  }, [s?.items, s?.assistantDraft]);

  // Rail visibility init: .dock mounts in the same frame as the chat area, #main's size does
  // not change from inner mounting, so the ResizeObserver does not fire; the dock may not
  // exist yet when initShell sets up its observer (sessions restore async), so compute once
  // proactively on mount here (both startup restore and switching back to a newly created
  // session pass through this remount)
  useLayoutEffect(() => {
    updateRailVisibility();
  }, []);

  const snapLockUntil = useRef(0);

  // Block scroll bleed-through from tab popups / inline expand cards into the outer message
  // stream (no chained propagation outward at the boundary)
  // and provide turn snap-to-top docking: when the next message sits too close to the top,
  // the next scroll lands exactly on its offsetTop, showing the full agent flow.
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

      // Turn snap-to-top docking: if the next message sits too close to the stream's top
      // edge (about to snap), the next downward scroll goes only as far as pinning that
      // message at the top, ensuring the agent's processing flow below is shown in full
      if (e.deltaY > 0) {
        const now = Date.now();
        if (now < snapLockUntil.current) {
          e.preventDefault();
          return;
        }
        const sections = stream.querySelectorAll<HTMLElement>(".turn-section");
        const streamTop = stream.getBoundingClientRect().top;
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const dist = sec.getBoundingClientRect().top - streamTop;
          if (dist > 1 && dist <= 140) {
            e.preventDefault();
            stream.scrollTop += dist;
            snapLockUntil.current = now + 200;
            return;
          }
        }
      }
    };

    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
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
        if (el) el.scrollTop = latestScrollTop(el);
      }}
    >
      <Icon name="down" />
    </button>
  );

  if (hubOpen) {
    return <AgentHub />;
  }

  if (!s) {
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

  if (mainViewMode === "tree") {
    return <MainSessionTree />;
  }

  // Message rail data: collected during render along the items traversal (key shares the
  // same source as the data-fk anchors)
  const railEntries: RailEntry[] = [];
  const streamTail =
    s.streaming || s.assistantDraft ? (
      <>
        {(s.streaming || s.assistantDraft) && <WorkSec />}
        {/* Streaming tail rendered as plain text (BUG-007 triple mine): only the finalized
            text goes to AssistantMsg */}
        {s.assistantDraft && !isJunkPlaceholder(s.assistantDraft) && (
          <div className="msg assistant md-body streaming-draft stream-plain">{s.assistantDraft}</div>
        )}
        {s.streaming && <ChatLoading />}
      </>
    ) : null;
  const nodes = renderItems(s.items, "", railEntries, streamTail);
  return (
    <>
      <TodoCard />
      {/* External-process write notice bar: set by the host's session_external_write frame;
          cleared when a reload rebuilds from disk */}
      {s.externalWrite && (
        <div className="extw-bar">
          <Icon name="info" />
          <span className="extw-tx">{t("chat.externalWriteNotice")}</span>
          {/* While this session itself is generating, a rebuild is refused host-side (it would
              orphan the running turn); disable it here too so the click is not a dead end.
              The live view keeps streaming, so nothing needs reloading mid-turn. */}
          <button
            type="button"
            className="save-btn"
            disabled={!!s.streaming}
            title={s.streaming ? t("chat.reloadRunning") : undefined}
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
      <MsgRail entries={railEntries} sessionId={s.sessionId} streamRef={streamRef} />
      <FindBar streamRef={streamRef} />
    </>
  );
}
