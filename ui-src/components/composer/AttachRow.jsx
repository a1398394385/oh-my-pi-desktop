// 附件行（原 composer.js renderAttachRow 平移）：待发送文件 chip（图片/文本），
// 每条可移除；数据 S.pendingFiles，空时不渲染（等价原 hidden）。
import { S, useStore, notify } from "../../store.js";
import Icon from "../../Icon.jsx";

export default function AttachRow() {
  useStore();
  if (S.pendingFiles.length === 0) return null;
  return (
    <div className="attach-row" id="attachRow">
      {S.pendingFiles.map((f) => (
        <span className="atchip" key={f.id}>
          <span className="at-ic"><Icon name={f.kind === "image" ? "image" : "file"} /></span>
          <span className="at-name" title={f.name}>{f.name}</span>
          <button
            className="atchip-x"
            title="移除"
            onClick={() => {
              S.pendingFiles = S.pendingFiles.filter((it) => it.id !== f.id);
              notify();
            }}
          >×</button>
        </span>
      ))}
    </div>
  );
}
