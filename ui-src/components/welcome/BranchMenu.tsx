// Branch menu (pops upward): branch list + ✓ check on the current branch + click
// to switch.
// Migrated from the wbBranchBtn open logic in ui/welcome.js; the git_branch_switched reply is
// landed by the store + toast.
// Aligned with the original: the menu container doesn't block clicks — clicking any item
// (including blank space bubbling to window) closes it.
// Parameterized (branches/current/cwd): shared by the welcome branch picker and the
// main-column header chip; the welcome call site passes the newSession* fields.
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { send } from "../../store";
import { placeMenu } from "../../shell";
import Icon from "../../Icon";

interface BranchMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
  branches: string[];
  remotes: string[]; // remote-tracking branches ("origin/xxx" form), rendered under a separator
  current: string;
  cwd: string;
  /** HEAD is not on a branch: `current` carries the short oid instead. */
  detached?: boolean;
}

export default function BranchMenu({ anchorRect, onClose, branches, remotes, current, cwd, detached }: BranchMenuProps) {
  const { t } = useTranslation();
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
      {/* Detached HEAD matches no row, so without this the menu opens with no ✓
          anywhere and the checked-out state looks unset rather than intentional. */}
      {detached && <div className="mi" style={{ opacity: 0.7, cursor: "default" }}>{t("gitPage.detachedHead", { oid: current })}</div>}
      {detached && (branches.length > 0 || remotes.length > 0) && <div className="sep" />}
      {branches.map((b) => (
        <div
          key={b}
          className="mi"
          onClick={() => {
            if (b !== current) send({ type: "switch_git_branch", cwd, branch: b });
            onClose();
          }}
        >
          <span className="ck">{b === current ? "✓" : ""}</span>
          {/* Branch icon same as the branch-picker capsule (branch), keeping the global icon style consistent */}
          <Icon name="branch" size={15} className="mi-ic" style={{ color: "var(--dim)" }} />
          {b}
        </div>
      ))}
      {/* Remote-tracking branches under a separator; picking one checks out a local tracking branch (host checkout --track) */}
      {remotes.length > 0 && <div className="sep" />}
      {remotes.map((b) => (
        <div
          key={b}
          className="mi"
          onClick={() => {
            if (b !== current) send({ type: "switch_git_branch", cwd, branch: b });
            onClose();
          }}
        >
          <span className="ck">{b === current ? "✓" : ""}</span>
          <Icon name="branch" size={15} className="mi-ic" style={{ color: "var(--dim)" }} />
          {b}
        </div>
      ))}
    </div>
  ), document.body);
}
