// Files a run changed, as one collapsible card at the run's tail (between the output and the
// fork/copy acts). The host owns the per-run snapshots: review opens the snapshot diff in the
// right panel, revert asks the host to restore this run's "before" image.
// Revert eligibility is a frontend rule: only the last run that touched a file without having
// been reverted may undo it — undoing an older run would also throw away the later edits.
import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "../../types/session";
import type { RunChangeFile } from "../../types/frames";
import { useAppStore } from "../../store/index";
import { splitPath } from "./util";
import { fileTypeIcon } from "../../../ui/icons";
import Icon from "../../Icon";
import { expandRightPanel } from "../main/right/tabs";
import { OpenWithMenu } from "../main/right/FilePage";
import { t } from "../../i18n";

// Relative to the session workspace; anything outside it keeps the absolute path
function displayPath(p: string, root: string): string {
  const abs = p.replace(/\\/g, "/");
  const rel = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return !rel || abs === rel || !abs.startsWith(rel + "/") ? abs : abs.slice(rel.length + 1);
}

// Last run whose (not yet reverted) changes include `path`, in item order
function lastLiveOwner(items: ChatItem[], path: string): string | undefined {
  let owner: string | undefined;
  for (const it of items) {
    if (it.role !== "assistant" || !it.changes) continue;
    if (it.changes.some((f) => f.path === path && !f.reverted)) owner = it.entryId;
  }
  return owner;
}

function activeSession() {
  const st = useAppStore.getState();
  return st.activePath ? st.openSessions.get(st.activePath) : undefined;
}

/** Snapshot diff (not the git diff) of one run's change to one file, in the right panel */
function openRunDiff(entryId: string, path: string): void {
  const s = activeSession();
  if (!s) return;
  expandRightPanel("rundiff", { runDiffView: { sessionId: s.sessionId, entryId, path, diff: "", loading: true } });
  useAppStore.getState().send({ type: "get_run_file_diff", sessionId: s.sessionId, entryId, path });
}

// Open the file itself in the right panel's file tab
function openRunFile(path: string): void {
  expandRightPanel("file", {
    fileView: { path, text: "", startLine: 1, lineNumbers: null, reqRange: null },
    fileViewPending: path,
  });
  useAppStore.getState().send({ type: "read_file", path });
}

export default function RunChanges({ entryId, changes }: { entryId?: string; changes: RunChangeFile[] }) {
  const [open, setOpen] = useState(false);
  // Path whose "open with" popover is showing; one popover per card, anchored to its chevron
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  // Path with a revert in flight (the button stays disabled until the host answers)
  const [pending, setPending] = useState<string | null>(null);
  // items is a fresh array per store update (updateSession slices), so this fires on every
  // frame — the same channel the chat list re-renders from
  const items = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.items : undefined));
  useEffect(() => setPending(null), [changes]);

  const cwd = activeSession()?.cwd ?? "";
  const added = changes.reduce((n, f) => n + f.added, 0);
  const removed = changes.reduce((n, f) => n + f.removed, 0);

  const revert = (path: string) => {
    const s = activeSession();
    if (!s || !entryId) return;
    setPending(path);
    // The host replies only on success (failures surface as a toast), so release the guard
    // after a while: a failed revert must not lock the button
    setTimeout(() => setPending((p) => (p === path ? null : p)), 8000);
    useAppStore.getState().send({ type: "revert_run_file", sessionId: s.sessionId, entryId, path });
  };

  return (
    <div className={"rchg" + (open ? " open" : "")}>
      <button className="rchg-head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="pencil" size={14} className="rchg-ic" />
        <span className="rchg-title">{t("chat.runChanges", { count: changes.length })}</span>
        <span className="rchg-sum">
          {added > 0 ? <span className="add">{`+${added}`}</span> : null}
          {removed > 0 ? <span className="del">{`−${removed}`}</span> : null}
        </span>
        <Icon name="chevronDown" className="rchg-chev" />
      </button>
      {open ? (
        <div className="rchg-body">
          {changes.map((f) => {
            const { dir, name } = splitPath(displayPath(f.path, cwd));
            const live = entryId !== undefined && items !== undefined && lastLiveOwner(items, f.path) === entryId;
            const gone = !!f.deleted || (!!f.created && !!f.reverted); // no file to open any more
            const revertWhy = f.noSnapshot
              ? t("chat.runChangeNoSnapshot")
              : f.reverted
                ? t("chat.runChangeReverted")
                : live
                  ? undefined
                  : t("chat.runChangeLater");
            return (
              <div className={"rchg-row" + (f.reverted ? " reverted" : "")} key={f.path}>
                <span className="rchg-file">
                  <Icon name={fileTypeIcon(name)} className="rchg-fic" size={18} />
                  <span className="rchg-name">{name}</span>
                  {/* shortcut: end-ellipsis on the directory; the row title carries the full path */}
                  <span className="rchg-dir" title={f.path}>{dir}</span>
                </span>
                <span className="rchg-counts">
                  {f.added > 0 ? <span className="add">{`+${f.added}`}</span> : null}
                  {f.removed > 0 ? <span className="del">{`−${f.removed}`}</span> : null}
                </span>
                <span className="rchg-btns">
                  <button
                    className="rchg-btn"
                    type="button"
                    disabled={gone || !!f.noSnapshot}
                    title={gone ? t("chat.runChangeGone") : f.noSnapshot ? t("chat.runChangeNoSnapshot") : undefined}
                    onClick={() => entryId && openRunDiff(entryId, f.path)}
                  >
                    {t("chat.runChangeReview")}
                  </button>
                  <button
                    className="rchg-btn"
                    type="button"
                    disabled={gone || !!revertWhy || pending === f.path}
                    title={revertWhy}
                    onClick={() => revert(f.path)}
                  >
                    {t("chat.runChangeRevert")}
                  </button>
                  <span className="rchg-open">
                    <button
                      className="rchg-btn"
                      type="button"
                      disabled={gone}
                      title={gone ? t("chat.runChangeGone") : undefined}
                      onClick={() => openRunFile(f.path)}
                    >
                      {t("chat.runChangeOpen")}
                    </button>
                    <button
                      className="rchg-btn rchg-open-chev"
                      type="button"
                      disabled={gone}
                      aria-label={t("right.openWithTitle")}
                      aria-expanded={menuPath === f.path}
                      onClick={(e) => {
                        menuAnchor.current = e.currentTarget;
                        setMenuPath(menuPath === f.path ? null : f.path);
                      }}
                    >
                      <Icon name="chevronDown" size={12} />
                    </button>
                  </span>
                </span>
                {f.reverted ? <span className="rchg-tag">{t("chat.runChangeReverted")}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {menuPath ? (
        <OpenWithMenu
          key={menuPath}
          target={menuPath}
          root={cwd}
          file
          open
          onClose={() => setMenuPath(null)}
          anchor={menuAnchor}
        />
      ) : null}
    </div>
  );
}
