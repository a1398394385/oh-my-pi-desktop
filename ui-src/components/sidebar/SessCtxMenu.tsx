// 会话行右键菜单（ui/sidebar.js initSidebar 的 contextmenu 分支平移）：
// 复制 sessionId/文件路径 + 重命名 + 归档。原版捕获阶段拦截 shell 菜单的协调问题在
// React 版不存在（菜单即组件），选词撤销逻辑留在 Sidebar 容器层。
import { send, toast } from "../../store";
import Menu from "./Menu";
import { copyText } from "./util";
import type { SessionInfo } from "./SessionRow";

export default function SessCtxMenu({ entry, x, y, onClose, onRename }: {
  entry: SessionInfo;
  x: number;
  y: number;
  onClose: () => void;
  onRename: (entry: SessionInfo) => void;
}) {
  const item = (label: string, fn: () => void) => (
    <button key={label} onClick={() => { onClose(); fn(); }}>{label}</button>
  );
  return (
    <Menu
      place={(mr) => [
        Math.max(8, Math.min(x, window.innerWidth - mr.width - 8)),
        Math.max(8, Math.min(y, window.innerHeight - mr.height - 8)),
      ]}
      onClose={onClose}
    >
      {item("复制 sessionId", () => {
        copyText(entry.id ?? "");
        toast("已复制：复制 sessionId");
      })}
      {item("复制会话文件路径", () => {
        copyText(entry.path);
        toast("已复制：复制会话文件路径");
      })}
      {item("重命名", () => onRename(entry))}
      {item("归档会话", () => send({ type: "archive_session", sessionId: entry.id, archived: true }))}
    </Menu>
  );
}
