// Chat area: TODO process card (statusWrap) + message stream (stream) + message rail
// (msgRail) + "working Ns" row (WorkSec) + in-session find (⌘F). The streaming status row
// (spinner + dynamic text) lives in ChatLoading.
// Migrated from renderChat in ui/chat.js + the scroll handling of markdown.js:
// - Scroll following (stickBottom semantics): switching sessions forces bottom; when glued
//   to the bottom, any re-render (streaming append / expand body) stays pinned. The
//   at-bottom check must happen before the DOM update — use the pre-render state recorded
//   continuously by the scroll listener; after rendering, scrollHeight has already changed
//   and cannot be inferred backwards (120px tolerance as in the original).
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

// Button visibility: shown only while the message stream still has downward scroll room
// (4px tolerance against subpixel jitter)
function updateScrollBottomVis(el: HTMLElement | null, btn: HTMLElement | null) {
  if (!el || !btn) return;
  btn.classList.toggle("hidden", !(el.scrollHeight - el.scrollTop - el.clientHeight > 4));
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
    // on a new outgoing message force-scroll to the bottom (the last turn's min-height:100%
    // puts the new message right at the top);
    // during streaming, keep following while glued to the bottom
    if (switched || isNewUserMsg || atBottom.current) {
      el.scrollTop = el.scrollHeight;
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
  // the next scroll lands exactly on its offsetTop, showing the full agent flow
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const card = target.closest<HTMLElement>(
        ".ed-brief, .cmd-card, .bash-out, .think-body, .chg-body, .approval-card, #todoList",
      );
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

    stream.addEventListener("wheel", onWheel, { passive: false });
    return () => stream.removeEventListener("wheel", onWheel);
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
        if (el) el.scrollTop = el.scrollHeight;
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
          <button type="button" className="save-btn" onClick={() => send({ type: "reload_session", path: activePath })}>
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
