// `out://` mid-call reply card. Base parity (pi 18.16): a reply is its own assistant block
// drawn right after the call that produced it — a `write` to out:// replaces its tool row
// entirely (the base's ReplyWriteComponent is what mounts, not the tool card), while
// eval/bash replies follow their terminal row. The text grows from the streamed call body
// (`tool_args` → item.streamText) and the settled reply array is authoritative afterwards.
import MdSurface from "./MdSurface";
import { t } from "../../i18n";

export default function OutReply({ texts }: { texts: string[] }) {
  return (
    <div className="out-reply">
      <div className="out-reply-lbl">{t("chat.toolReplies")}</div>
      {texts.map((text, i) => (
        <MdSurface className="md-body md-surface" text={text} key={i} />
      ))}
    </div>
  );
}
