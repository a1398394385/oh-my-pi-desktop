// Streaming loading spinner + dynamic status text (the former ChatLoading spinner merged
// with WorkLine's text):
// hangs at the end of the message stream, above the composer and flush left (the stream is
// the same width as the composer; the icon sits at the composer's top-left corner),
// rendered while s.streaming is true, disappearing with the state when the turn ends.
// lucide loader icon + CSS spin, colored with --dim.
// Text comes from workingText (intent/thinking), falling back to the chat.processing label
// when absent; the structure is stable, so text changes only update the text node.
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

export default function ChatLoading() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const text = s?.streaming ? s.workingText || t("chat.processing") : "";
  return (
    <div className="flex items-center min-h-[20px] py-[2px]" role="status" aria-label={text || t("chat.loadingAria")}>
      <Icon name="loader" size={16} className="chat-loading-icon" />
      {text && <span className="ml-[7px] text-ui-sm text-dim truncate" title={text}>{text}</span>}
    </div>
  );
}
