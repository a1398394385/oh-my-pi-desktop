// @ 文件提及行（fileMention 落盘回读）：单行 dim 文本「读取 <paths>」，路径等宽，无展开。
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
