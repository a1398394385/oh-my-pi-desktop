// 分支菜单（向上弹出）：newSessionBranches 列表 + 当前分支 ✓ 勾选 + 点击切换。
// 迁移自 ui/welcome.js wbBranchBtn 打开逻辑；切换回包 git_branch_switched 由 store 落地 + toast。
// 对照原版：菜单容器不做 click 阻断，点击任意项（含空白处冒泡到 window）都会关闭。
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAppStore, send } from "../../store";
import { placeMenu } from "../../shell";
import Icon from "../../Icon";

interface BranchMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export default function BranchMenu({ anchorRect, onClose }: BranchMenuProps) {
  const branches = useAppStore((s) => s.newSessionBranches);
  const curBranch = useAppStore((s) => s.newSessionBranch);
  const project = useAppStore((s) => s.newSessionProject);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    placeMenu(menu, 0, 0);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchorRect.top - rect.height - 4, window.innerHeight - rect.height - 8));
    placeMenu(menu, left, top);
  });

  return createPortal((
    <div
      id="wbBranchMenu"
      className="menu open"
      ref={menuRef}
    >
      {branches.map((b) => (
        <div
          key={b}
          className="mi"
          onClick={() => {
            if (b !== curBranch) send({ type: "switch_git_branch", cwd: project, branch: b });
            onClose();
          }}
        >
          <span className="ck">{b === curBranch ? "✓" : ""}</span>
          {/* 分支图标与分支选择胶囊同款（branch），保持全局图标风格一致 */}
          <Icon name="branch" size={15} className="mi-ic" style={{ color: "var(--dim)" }} />
          {b}
        </div>
      ))}
    </div>
  ), document.body);
}
