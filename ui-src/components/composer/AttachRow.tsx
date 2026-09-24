// 附件行（原 composer.js renderAttachRow 平移）：待发送文件 chip（图片/文本），
// 每条可移除；数据 S.pendingFiles，空时不渲染（等价原 hidden）。
import { S, useStore, notify } from "../../store";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";

// 待发送附件（S.pendingFiles 元素的结构子集，全量形态见 types/session）
type PendingFile = { id: number; name?: string; kind: string };

export default function AttachRow() {
  useStore();
  if (S.pendingFiles.length === 0) return null;
  return (
    <div className="attach-row" id="attachRow">
      {S.pendingFiles.map((f: PendingFile) => (
        <span className="atchip" key={f.id}>
          <span className="at-ic"><Icon name={f.kind === "image" ? "image" : fileTypeIcon(f.name)} /></span>
          <span className="at-name" title={f.name}>{f.name}</span>
          <button
            className="atchip-x"
            title="移除"
            onClick={() => {
              S.pendingFiles = S.pendingFiles.filter((it: PendingFile) => it.id !== f.id);
              notify();
            }}
          >×</button>
        </span>
      ))}
    </div>
  );
}
