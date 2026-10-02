// Branch menu (pops upward): newSessionBranches list + ✓ check on the current branch + click
// to switch.
// Migrated from the wbBranchBtn open logic in ui/welcome.js; the git_branch_switched reply is
// landed by the store + toast.
// Aligned with the original: the menu container doesn't block clicks — clicking any item
// (including blank space bubbling to window) closes it.
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
          {/* Branch icon same as the branch-picker capsule (branch), keeping the global icon style consistent */}
          <Icon name="branch" size={15} className="mi-ic" style={{ color: "var(--dim)" }} />
          {b}
        </div>
      ))}
    </div>
  ), document.body);
}
