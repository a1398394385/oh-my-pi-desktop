// @ file mention row (fileMention persisted read-back): a single dim text line "Read
// <paths>" via the chat.labelRead key, paths in monospace, no expansion.
import type { MentionItem } from "../../types/session";
import { t } from "../../i18n";

export default function MentionRow({ item }: { item: MentionItem }) {
  const files = item.files || [];
  return (
    <div className="act mention">
      <span className="lbl">{t("chat.labelRead")}</span>
      <span className="m-paths" title={files.join("\n")}>{files.join("、")}</span>
    </div>
  );
}
