// Branch tree page: current session's family (get_session_tree lazily fetched; old data
// counts as stale after a session switch)
// + tree rendering grouped by parentSession + clicking a branch row switches sessions.
import { Fragment, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, activateSession, refreshGitDiff, hideWelcomeScreen, saveUnseen } from "../../../store";
import type { DiskProject, SessionBranch } from "../../../types/frames";
import { t } from "../../../i18n";
import { fmtAgo } from "./helpers";

// Family branch entry: sole source is types/frames' SessionBranch (host get_session_tree reply)
type BranchEntry = SessionBranch;

// Branch row title: title → truncated first message from the disk list → "unnamed branch"
// (no first message when the branch was just created and isn't in list_sessions yet)
function branchLabel(b: BranchEntry, diskProjects: DiskProject[]): string {
  if (b.title && b.title.trim()) return b.title;
  const fm = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === b.path)?.firstMessage;
  if (fm && fm.trim()) return fm.length > 40 ? fm.slice(0, 40) + "…" : fm;
  return t("right.unnamedBranch");
}

// Click a branch row to switch sessions: the same action set as clicking the sidebar list
// (already open → activate directly; otherwise the host load_session)
function loadBranchSession(path: string) {
  useAppStore.setState({ isCreatingNew: false });
  hideWelcomeScreen();
  // Unread mark removal swaps in a new Set (formerly mutate + notify at the end; the sidebar
  // subscribing to unseenFinished notices by reference)
  useAppStore.setState((st) => ({ unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)) }));
  saveUnseen();
  if (useAppStore.getState().openSessions.has(path)) {
    activateSession(path);
    refreshGitDiff();
  } else {
    send({ type: "reload_settings" }); // local config may have changed; fetch the latest model settings
    send({ type: "load_session", path });
  }
  // selectedFile/selectedSubagent cleanup is owned by restoreRightPanel (already-open branch)
  // and the session_created frame (host-load branch) — resetting here would clobber the
  // just-restored per-session right panel state
}

export default function BranchTreePage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  // Stale-data refetch (the inline request from the old render body moved here; dedup via
  // pending reads getState, replies land in the store cache).
  // No dependency array = check after every render, matching the old "check on every repaint"
  // semantics (a failed request clears pending and the next render refetches)
  useEffect(() => {
    const st = useAppStore.getState();
    const session = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!session) return;
    const tree = st.rightState.sessionTree;
    if (tree && tree.sessionId === session.sessionId) return; // not stale
    if (st.rightState.sessionTreePending) return; // dedup
    useAppStore.setState((st2) => ({
      rightState: { ...st2.rightState, sessionTreePending: true, treeFor: session.sessionId }, // for attribution when the reply carries no sessionId
    }));
    send({ type: "get_session_tree", sessionId: session.sessionId });
  });
  if (!s) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  const tree = rightState.sessionTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // old data counts as stale after switching sessions
  if (stale) {
    return <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>;
  }
  const branches = tree.branches ?? [];
  if (branches.length <= 1) {
    return <div className="py-[18px] text-faint text-ui-base leading-[1.6]" /* style-token-ignore */>{t("right.noOtherBranches")}</div>;
  }
  // Group into a tree by parentSession: root branches (no parent, or parent absent from the
  // family list) at the top, children indented under parents (unlimited depth, uniform styling)
  const byId = new Map(branches.map((b: BranchEntry) => [b.sessionId, b] as const));
  const kidsOf = new Map<string, BranchEntry[]>();
  const roots: BranchEntry[] = [];
  for (const b of branches) {
    if (b.parentSession && byId.has(b.parentSession)) {
      const list = kidsOf.get(b.parentSession) ?? [];
      list.push(b);
      kidsOf.set(b.parentSession, list);
    } else roots.push(b);
  }
  // Assertion: the fallback 0 for a missing modified coerces through Date.parse the same as
  // the original (NaN)
  const byTime = (x: BranchEntry, y: BranchEntry): number =>
    Date.parse((y.modified || 0) as string) - Date.parse((x.modified || 0) as string); // newer first within a level
  roots.sort(byTime);
  for (const l of kidsOf.values()) l.sort(byTime);
  return (
    <div className="py-1.5">
      <BranchLevel items={roots} kidsOf={kidsOf} depth={0} />
    </div>
  );
}

// Single-level branch rows (current branch cur highlighted, unclickable) + nested child
// containers (vertical guide lines, indented per level)
function BranchLevel({ items, kidsOf, depth }: { items: BranchEntry[]; kidsOf: Map<string, BranchEntry[]>; depth: number }) {
  const { t } = useTranslation();
  const diskProjects = useAppStore((st) => st.diskProjects); // re-render when the title-fallback source (disk session list) changes
  return (
    <div className={depth > 0 ? "ml-2.5 pl-2.5 border-l border-line-soft" : undefined}>
      {items.map((b) => {
        const kids = kidsOf.get(b.sessionId);
        return (
          <Fragment key={b.sessionId}>
            <button className={"bt-row" + (b.isCurrent ? " cur" : "")} title={b.path} onClick={b.isCurrent ? undefined : () => loadBranchSession(b.path)}>
              <span className="flex-1 min-w-0 text-ui-base overflow-hidden text-ellipsis whitespace-nowrap">{branchLabel(b, diskProjects)}</span>
              <span className="flex-none text-ui-xs text-faint">
                {[b.messageCount != null ? t("right.messageCount", { count: b.messageCount }) : null, b.modified ? fmtAgo(b.modified) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            {kids?.length ? <BranchLevel items={kids} kidsOf={kidsOf} depth={depth + 1} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}
