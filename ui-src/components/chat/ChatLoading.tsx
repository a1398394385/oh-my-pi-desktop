// Streaming status row: hangs at the end of the message stream, above the composer and flush
// left (the stream is the same width as the composer; the icon sits at the composer's
// top-left corner), rendered while s.streaming is true and disappearing with the turn.
// The leading icon names the running activity instead of a spinner: the thinking glyph while
// the model thinks, else the running tool's own glyph. Tool glyphs come from rowSpec so this
// row and the right rail's activity feed can never disagree on a tool's icon.
// Text is workingText (intent / thinking label); while thinking, the thought's tail streams
// dim on the right so the row shows what is actually being considered.
import { useEffect, useRef, useState } from "react";
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

// Only the tail is rendered: the thought can run to tens of thousands of chars, and a bounded
// slice keeps the per-frame paint cheap while still scrolling the newest words into view.
// `shownLen` is how much of the thought the row has painted so far (see SmoothThought).
const THINKING_TAIL = 160;
export function thoughtWindow(thinking: string, shownLen: number): string {
  return thinking.slice(Math.max(0, shownLen - THINKING_TAIL), shownLen).replace(/\s+/g, " ");
}

// The host flushes thinking deltas in ~100ms batches, so painting each batch whole reads as a
// stutter: tens of chars appear at once, then nothing. Paint toward the target over several
// animation frames instead (a step proportional to the backlog catches up inside one batch
// window). Progress is tracked as a character count over the FULL thought, not the tail text:
// the tail window slides left as the thought grows, so comparing painted text to the tail would
// snap on every batch past THINKING_TAIL. Only the window is sliced per frame, so the frame
// cost stays bounded however long the thought runs.
const CATCH_UP_FRAMES = 6;
const THOUGHT_HEAD = 32;
function SmoothThought({ text }: { text: string }) {
  const [shownLen, setShownLen] = useState(text.length);
  const shownRef = useRef(text.length);
  // A different thought (or a shorter replayed one) has no shared prefix to animate from:
  // its head changes, or it is shorter than what is already painted. Snap instead of typing.
  const headRef = useRef(text.slice(0, THOUGHT_HEAD));
  useEffect(() => {
    const head = text.slice(0, THOUGHT_HEAD);
    if (head !== headRef.current || text.length < shownRef.current) {
      headRef.current = head;
      shownRef.current = text.length;
      setShownLen(text.length);
      return;
    }
    if (shownRef.current === text.length) return;
    let raf = requestAnimationFrame(function tick() {
      const pending = text.length - shownRef.current;
      if (pending <= 0) return;
      shownRef.current += Math.ceil(pending / CATCH_UP_FRAMES);
      setShownLen(shownRef.current);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [text]);
  const shown = thoughtWindow(text, shownLen);
  return <span className="ml-[8px] min-w-0 text-ui-sm text-faint truncate" title={shown}>{shown}</span>;
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
