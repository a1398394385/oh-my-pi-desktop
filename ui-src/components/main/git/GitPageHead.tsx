// Git page header row, rendered inside the center topbar (MainHeader) instead of the
// page's own bar: the workspace switcher (the checkout the page reads) and the repo
// root path. The page publishes what this needs (gitPageHead) and asks for a re-read
// through the reload signal, so opening the switcher still sees a worktree created
// after the page loaded.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { pathBase, useAppStore } from "../../../store";
import Menu from "../sidebar/Menu";

// Picked from ui/prototypes/git-workspace-icons.html (#08 folder-git-2): the
// workspace pill shows a checkout/working tree, not a branch.
const WS_ICON = "folderGit2";

export default function GitPageHead() {
  const { t } = useTranslation();
  const gitManage = useAppStore((s) => s.gitManage);
  const head = useAppStore((s) => s.gitPageHead);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  // Menu has no Escape handling of its own (it only closes on an outside click).
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  // A workspace switch leaves the published frame behind (the page reloads for the
  // new checkout): only the frame of the open project may show.
  if (!head || !gitManage || head.cwd !== gitManage) return null;

  const worktrees = head.worktrees;
  const currentTree = worktrees.find((w) => w.current);
  const others = worktrees.filter((w) => !w.current);
  // The primary checkout (git lists it first) is named by role instead of by branch:
  // with every checkout of a repo merged into one page, "main" no longer says what it
  // is. Branch names identify the other checkouts; detached ones fall back to the
  // directory name.
  const primary = worktrees[0];
  const label = currentTree
    ? currentTree === primary
      ? t("gitPage.worktreeMain")
      : currentTree.detached
        ? pathBase(currentTree.path)
        : currentTree.branch
    : head.branch || pathBase(head.cwd);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={"head-chip clickable gp-ws" + (open ? " active" : "")}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("gitPage.worktreeSwitch")}
        onClick={(e) => {
          // The opening click must not reach the window: the menu it mounts
          // listens there for outside clicks and would close itself in the
          // same dispatch.
          e.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          // Re-read on open: a worktree created after the page loaded is
          // otherwise missing until the next manual refresh.
          useAppStore.getState().reloadGitPage(false);
          setOpen(true);
        }}
      >
        <Icon name={WS_ICON} size={13} style={{ color: "var(--dim)" }} />
        <span>{label}</span>
        <span className="caret-svg"><Icon name="caret" size={12} /></span>
      </button>
      {open && (
        <Menu
          place={() => {
            const r = trigger.current!.getBoundingClientRect();
            return [r.left, r.bottom + 6];
          }}
          onClose={() => setOpen(false)}
        >
          {others.length === 0 ? (
            <div className="gp-ws-empty">{t("gitPage.worktreeNone")}</div>
          ) : (
            others.map((wt) => (
              <button
                key={wt.path}
                type="button"
                className="gp-ws-row"
                title={wt.path}
                onClick={() => {
                  setOpen(false);
                  useAppStore.getState().openGitManage(wt.path);
                }}
              >
                <span className="gp-ws-row-path">{wt === primary ? t("gitPage.worktreeMain") : pathBase(wt.path)}</span>
                <span className="gp-ws-row-branch">
                  {wt.detached ? t("gitPage.worktreeDetached") : wt.branch}
                </span>
              </button>
            ))
          )}
        </Menu>
      )}
      {head.root && (
        <span className="gp-root" title={head.root}>
          {head.root}
        </span>
      )}
    </>
  );
}
