// Streaming status row: hangs at the end of the message stream, above the composer and flush
// left (the stream is the same width as the composer; the icon sits at the composer's
// top-left corner), rendered while s.streaming is true and disappearing with the turn.
// The leading icon names the running activity instead of a spinner: the thinking glyph while
// the model thinks, else the running tool's own glyph. Tool glyphs come from rowSpec so this
// row and the right rail's activity feed can never disagree on a tool's icon.
// Text is workingText (intent / thinking label); while thinking, the thought streams dim on the
// right as lines: it paints from the left edge until it reaches the row's right edge, then the
// line clears and the next words paint again from the left.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { rowSpec } from "../main/right/subRowSpec";
import type { ChatItem } from "../../types/session";

// The live entry is the last streaming thinking block or running tool, scanned from the end.
// A settled tool still names the run's current activity: between a tool returning and the next
// thinking phase the row is generating its reply, and falling back to the thinking glyph there
// made the row read "still thinking" long after the thought ended.
export function liveActivity(items: ChatItem[]): { icon: string; thinking?: string } {
  let lastTool: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "thinking" && it.streaming) return { icon: "think", thinking: it.thinking || "" };
    if (it.role === "tool") {
      const icon = rowSpec({ name: it.name || "", args: it.args, running: true }).icon;
      if (it.running) return { icon };
      lastTool ??= icon;
    }
  }
  return { icon: lastTool ?? "think" };
}

// A bounded slice keeps the per-frame paint cheap however long the thought runs. `shownLen` is
// how much of the thought the row has painted so far and `from` is where the current line starts
// (SmoothThought advances it when a line fills the row); THINKING_TAIL only caps a line that never
// reached the right edge.
const THINKING_TAIL = 160;
export function thoughtWindow(thinking: string, shownLen: number, from = 0): string {
  return thinking.slice(Math.max(from, shownLen - THINKING_TAIL), shownLen).replace(/\s+/g, " ");
}

// The host flushes thinking deltas in ~100ms batches, so painting each batch whole reads as a
// stutter: tens of chars appear at once, then nothing. Paint toward the target over several
// animation frames instead (a step proportional to the backlog catches up inside one batch
// window). Progress is tracked as a character count over the FULL thought, not the painted text:
// the line resets and restarts at a later offset, so comparing visible text to the target would
// snap on every reset. Only the line is sliced per frame, so the frame cost stays bounded however
// long the thought runs.
// MAX_STEP caps a frame at roughly half a line: a large backlog (session restore, a long-buffered
// flush) would otherwise repaint, overflow and clear the same frame over and over, leaving the
// row flickering empty.
const CATCH_UP_FRAMES = 6;
const MAX_STEP = 24;
const THOUGHT_HEAD = 32;
function SmoothThought({ text }: { text: string }) {
  const [shownLen, setShownLen] = useState(text.length);
  const shownRef = useRef(text.length);
  // First char of the current line: when the painted text hits the row's right edge this moves up
  // to the newest painted offset, so the line clears and the following words start from the left.
  const [from, setFrom] = useState(0);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const txtRef = useRef<HTMLSpanElement | null>(null);
  // A different thought (or a shorter replayed one) has no shared prefix to animate from:
  // its head changes, or it is shorter than what is already painted. Snap instead of typing.
  const headRef = useRef(text.slice(0, THOUGHT_HEAD));
  useEffect(() => {
    const head = text.slice(0, THOUGHT_HEAD);
    if (head !== headRef.current || text.length < shownRef.current) {
      headRef.current = head;
      shownRef.current = text.length;
      setShownLen(text.length);
      setFrom(0);
      return;
    }
    if (shownRef.current === text.length) return;
    let raf = requestAnimationFrame(function tick() {
      const pending = text.length - shownRef.current;
      if (pending <= 0) return;
      shownRef.current += Math.min(Math.ceil(pending / CATCH_UP_FRAMES), MAX_STEP);
      setShownLen(shownRef.current);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [text]);
  const painted = thoughtWindow(text, shownLen, from);
  // Overflow check runs after paint: the inline text keeps its natural width (nowrap), so a line
  // that reached the right edge is detectable before the wrapper's overflow:hidden eats it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const el = txtRef.current;
    if (!box || !el || !box.clientWidth) return;
    if (el.getBoundingClientRect().width > box.clientWidth) setFrom(shownLen);
  }, [painted, shownLen]);
  return (
    <span ref={boxRef} className="ml-[8px] flex-1 min-w-0 overflow-hidden text-ui-sm text-faint" title={painted}>
      <span ref={txtRef} className="whitespace-nowrap">{painted}</span>
    </span>
  );
}

export default function ChatLoading() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const text = s?.streaming ? s.workingText || t("chat.processing") : "";
  const activity = s?.streaming && s.items ? liveActivity(s.items) : { icon: "think" };
  const thinking = activity.thinking || "";
  return (
    <div className="flex items-center min-h-[20px] py-[2px]" role="status" aria-label={text || t("chat.loadingAria")}>
      <Icon name={activity.icon} size={16} className="chat-loading-icon" />
      {text && <span className="ml-[7px] text-ui-sm text-dim truncate shrink-0 shimmer" title={text}>{text}</span>}
      {thinking.trim() && <SmoothThought text={thinking} />}
    </div>
  );
}
