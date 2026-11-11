// Streaming status row: hangs at the end of the message stream, above the composer and flush
// left (the stream is the same width as the composer; the icon sits at the composer's
// top-left corner), rendered while s.streaming is true and disappearing with the turn.
// The leading icon names the running activity instead of a spinner: the thinking glyph while
// the model thinks, else the running tool's own glyph. Tool glyphs come from rowSpec so this
// row and the right rail's activity feed can never disagree on a tool's icon.
// Text is workingText (intent / thinking label); while thinking, the thought's tail streams
// dim on the right so the row shows what is actually being considered.
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { rowSpec } from "../main/right/subRowSpec";
import type { ChatItem } from "../../types/session";

// The live entry is the last streaming thinking block or running tool; scanning from the end
// means a finished entry never keeps the previous activity's icon on screen.
export function liveActivity(items: ChatItem[]): { icon: string; thinking?: string } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "thinking" && it.streaming) return { icon: "think", thinking: it.thinking || "" };
    if (it.role === "tool" && it.running) return { icon: rowSpec({ name: it.name || "", args: it.args, running: true }).icon };
  }
  return { icon: "think" };
}

// Only the tail is rendered: the thought can run to tens of thousands of chars, and a bounded
// slice keeps the 100ms delta flush cheap while still scrolling the newest words into view.
const THINKING_TAIL = 160;
export function thoughtTail(thinking: string): string {
  return thinking.replace(/\s+/g, " ").trim().slice(-THINKING_TAIL);
}

export default function ChatLoading() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const text = s?.streaming ? s.workingText || t("chat.processing") : "";
  const activity = s?.streaming && s.items ? liveActivity(s.items) : { icon: "think" };
  const thought = thoughtTail(activity.thinking || "");
  return (
    <div className="flex items-center min-h-[20px] py-[2px]" role="status" aria-label={text || t("chat.loadingAria")}>
      <Icon name={activity.icon} size={16} className="chat-loading-icon" />
      {text && <span className="ml-[7px] text-ui-sm text-dim truncate shrink-0 shimmer" title={text}>{text}</span>}
      {thought && <span className="ml-[8px] min-w-0 text-ui-sm text-faint truncate" title={thought}>{thought}</span>}
    </div>
  );
}
