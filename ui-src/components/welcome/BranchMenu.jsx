// 分支菜单（向上弹出）：S.newSessionBranches 列表 + 当前分支 ✓ 勾选 + 点击切换。
// 迁移自 ui/welcome.js wbBranchBtn 打开逻辑；切换回包 git_branch_switched 由 store 落地 + toast。
// 对照原版：菜单容器不做 click 阻断，点击任意项（含空白处冒泡到 window）都会关闭。
import { S, useStore, send } from "../../store.js";
import Icon from "../../Icon.jsx";

export default function BranchMenu({ pos, onClose }) {
  useStore();
  return (
    <div
      id="wbBranchMenu"
      className="menu open"
      style={{ left: pos.left + "px", bottom: pos.bottom + "px", top: "auto" }}
    >
      {S.newSessionBranches.map((b) => (
        <div
          key={b}
          className="mi"
          onClick={() => {
            if (b !== S.newSessionBranch) send({ type: "switch_git_branch", cwd: S.newSessionProject, branch: b });
            onClose();
          }}
        >
          <span className="ck">{b === S.newSessionBranch ? "✓" : ""}</span>
          {/* 分支图标与分支选择胶囊同款（branch），保持全局图标风格一致 */}
          <Icon name="branch" size={14} className="mi-ic" style={{ color: "var(--dim)" }} />
          {b}
        </div>
      ))}
    </div>
  );
}
