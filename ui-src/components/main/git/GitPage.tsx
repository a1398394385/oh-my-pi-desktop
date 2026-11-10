// Middle-column Git manager page (project row "more" → the Git entry) as two
// columns: the commit graph over the branch/tag lists on the left, a side panel
// on the right that switches between the project's uncommitted files and the
// selected commit's detail. Nothing is selected when the page opens, so the side
// panel starts on the working changes; picking a commit switches it over.
//
// Opening the page collapses both shell side columns so the two Git columns get
// the full width; leaving restores whatever the shell had before (a manual
// toggle made while the page was open is kept).
//
// Clicking a changed file anywhere opens the compare view over the graph column;
// the side panel stays on the list the file came from.
//
// Host side: host/rpc/git-graph.ts (graph/detail), host/rpc/git-compare.ts
// (both versions of a file); transport + page memo: store/git-graph.ts.
// The page owns its render state locally — it never touches the session pool.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { pathBase, useAppStore } from "../../../store";
import { cachedGitGraph, fetchGitCommitDetail, fetchGitGraph } from "../../../store/git-graph";
import type { GitCommitDetailFrame, GitCommitFileWire, GitGraphFrame } from "../../../types/frames";
import CommitGraph from "./CommitGraph";
import BranchPanel from "./BranchPanel";
import CommitDetail from "./CommitDetail";
import Menu from "../sidebar/Menu";
import WorktreeList from "./WorktreeList";
import FileCompare, { type CompareTarget } from "./FileCompare";
import SplitHandle from "./SplitHandle";
import type { WorktreeRow } from "./worktree-rows";

const INITIAL_LIMIT = 200;
const PAGE_STEP = 100;
// Picked from ui/prototypes/git-workspace-icons.html (#08 folder-git-2): the
// workspace pill shows a checkout/working tree, not a branch.
const WS_ICON = "folderGit2";

export default function GitPage() {
  const { t } = useTranslation();
  const cwd = useAppStore((s) => s.gitManage) ?? "";
  const status = useAppStore((s) => s.gitPageStatus);
  const [scope, setScope] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [graph, setGraph] = useState<GitGraphFrame | null>(() => cachedGitGraph(cwd, "", INITIAL_LIMIT));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetailFrame | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<"flat" | "tree">("flat");
  /** Layout of the working-changes list (independent of the commit file list). */
  const [worktreeView, setWorktreeView] = useState<"flat" | "tree">("flat");
  /** Which list the right side panel shows. */
  const [sideMode, setSideMode] = useState<"worktree" | "commit">("worktree");
  /** Open compare view; null = the graph column. */
  const [pair, setPair] = useState<CompareTarget | null>(null);
  const wsTrigger = useRef<HTMLButtonElement>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const graphSeq = useRef(0);

  // Menu has no Escape handling of its own (it only closes on an outside click);
  // the settings popovers get theirs from their own pages, so this page adds one.
  useEffect(() => {
    if (!wsOpen) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWsOpen(false);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [wsOpen]);

  // Another checkout is a different repository view: the scope, commit and open
  // diff of the previous workspace must not survive the switch.
  useEffect(() => {
    setScope("");
    setLimit(INITIAL_LIMIT);
    setSelected(null);
    setPair(null);
    setSideMode("worktree");
  }, [cwd]);

  // Shell side columns are collapsed for the page's lifetime. Restoring only the
  // columns the user did not re-expand keeps a manual toggle intact.
  useEffect(() => {
    const before = useAppStore.getState();
    const prev = { sidebarCollapsed: before.sidebarCollapsed, rightCollapsed: before.rightCollapsed };
    useAppStore.setState({ sidebarCollapsed: true, rightCollapsed: true });
    return () => {
      const cur = useAppStore.getState();
      useAppStore.setState({
        sidebarCollapsed: cur.sidebarCollapsed ? prev.sidebarCollapsed : cur.sidebarCollapsed,
        rightCollapsed: cur.rightCollapsed ? prev.rightCollapsed : cur.rightCollapsed,
      });
    };
  }, []);

  const runLoad = useCallback(
    (force: boolean) => {
      if (!cwd) return;
      const seq = graphSeq.current + 1;
      graphSeq.current = seq;
      fetchGitGraph({ cwd, scope, limit, force })
        .then((frame) => {
          if (seq !== graphSeq.current) return;
          if (!frame.ok) {
            setGraph(null);
            setError(frame.error ?? t("gitPage.failed"));
            return;
          }
          setError(null);
          setGraph(frame);
        })
        .catch((e) => {
          if (seq !== graphSeq.current) return;
          setGraph(null);
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq === graphSeq.current) setLoading(false);
        });
    },
    [cwd, scope, limit, t],
  );

  const loadStatus = useCallback(() => {
    if (!cwd) return;
    useAppStore.setState({ gitPageStatus: { cwd, files: [], state: "NORMAL", loading: true } });
    useAppStore.getState().send({ type: "get_git_diff", cwd });
  }, [cwd]);

  // Project/scope/page-size change: paint the memoized snapshot first (reopening
  // the page or flipping back to a branch is instant), then revalidate in the
  // background. The host's short-TTL cache usually serves the revalidation too.
  useEffect(() => {
    const hit = cachedGitGraph(cwd, scope, limit);
    if (hit) {
      setGraph(hit);
      setError(null);
      setLoading(false);
    } else {
      setLoading(true);
    }
    runLoad(false);
  }, [cwd, scope, limit, runLoad]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Keep a selection valid across reloads but never invent one: the page opens
  // with nothing selected so the side panel shows the working changes.
  useEffect(() => {
    const commits = graph?.commits ?? [];
    setSelected((prev) => (prev && commits.some((c) => c.oid === prev) ? prev : null));
  }, [graph]);

  // Detail of the selected commit; the alive flag drops replies of a superseded
  // selection (rapid clicking must not land an older commit's files).
  useEffect(() => {
    if (!cwd || !selected) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    fetchGitCommitDetail({ cwd, oid: selected })
      .then((frame) => {
        if (!alive) return;
        if (!frame.ok) setDetailError(frame.error ?? t("gitPage.failed"));
        else setDetail(frame);
      })
      .catch((e) => {
        if (alive) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, selected, t]);

  // A compare view belongs to the commit it was opened from: switching rows
  // drops it instead of showing the previous commit's file against a new one.
  useEffect(() => {
    setPair(null);
  }, [selected]);

  const pickScope = (next: string) => {
    setScope(next);
    setLimit(INITIAL_LIMIT);
  };
  const selectCommit = useCallback((oid: string) => {
    setSelected(oid);
    setSideMode("commit");
  }, []);
  const close = () => useAppStore.getState().closeGitManage();
  const refresh = () => {
    runLoad(true);
    loadStatus();
  };

  const currentBranch = graph?.branch ?? "";
  const worktrees = graph?.worktrees ?? [];
  const currentTree = worktrees.find((w) => w.current);
  // The menu offers the other checkouts only: switching to the current one is a
  // no-op, and repeating it beside the pill reads as a second name for this page.
  const others = worktrees.filter((w) => !w.current);
  // Branch names identify a checkout: the main repo keeps its own, a worktree
  // carries the branch it was created on. Detached checkouts fall back to the
  // directory name, and before the first graph reply to the page's own branch.
  // The primary checkout (git lists it first) is named by role instead: with every
  // checkout of a repo merged into one project, "main" no longer says what it is.
  const isPrimary = (wt: { path: string } | undefined) => !!wt && wt === worktrees[0];
  const wsLabel = currentTree
    ? isPrimary(currentTree)
      ? t("gitPage.worktreeMain")
      : currentTree.detached
        ? pathBase(currentTree.path)
        : currentTree.branch
    : graph?.branch || pathBase(cwd);
  const detailOid = detail?.commit?.oid ?? "";
  const openCommitFile = (file: GitCommitFileWire) => {
    setSideMode("commit");
    setPair({
      cwd,
      path: file.path,
      oldPath: file.oldPath,
      oid: detailOid,
      origin: "commit",
    });
  };
  const openWorktreeFile = (row: WorktreeRow) => {
    setSideMode("worktree");
    setPair({ cwd, path: row.file.path, staged: row.half === "staged", origin: "worktree" });
  };
  const worktreeFiles = useMemo(() => (status?.cwd === cwd ? status.files : []), [status, cwd]);
  const worktreeLoading = status?.cwd === cwd ? status.loading : true;
  const branchLists = useMemo(
    () => ({
      local: graph?.branches?.local ?? [],
      remotes: graph?.branches?.remotes ?? [],
      tags: graph?.branches?.tags ?? [],
    }),
    [graph],
  );

  return (
    <div id="gitPage">
      <div className="gp-head">
        <span className="gp-project" title={cwd}>
          {pathBase(cwd)}
        </span>
        <div className="gp-ws-wrap">
          <button
            ref={wsTrigger}
            type="button"
            className="gp-ws"
            aria-expanded={wsOpen}
            aria-haspopup="menu"
            title={t("gitPage.worktreeSwitch")}
            onClick={(e) => {
              // The opening click must not reach the window: the menu it mounts
              // listens there for outside clicks and would close itself in the
              // same dispatch.
              e.stopPropagation();
              if (wsOpen) {
                setWsOpen(false);
                return;
              }
              // Re-read on open: a worktree created after the page loaded is
              // otherwise missing until the next manual refresh.
              runLoad(true);
              setWsOpen(true);
            }}
          >
            <Icon name={WS_ICON} size={13} />
            <span className="gp-ws-label">{wsLabel}</span>
            <Icon name="caretSlim" size={10} className="gp-ws-caret" />
          </button>
          {wsOpen && (
            <Menu
              place={() => {
                const r = wsTrigger.current!.getBoundingClientRect();
                return [r.left, r.bottom + 6];
              }}
              onClose={() => setWsOpen(false)}
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
                      setWsOpen(false);
                      useAppStore.getState().openGitManage(wt.path);
                    }}
                  >
                    <span className="gp-ws-row-path">{isPrimary(wt) ? t("gitPage.worktreeMain") : pathBase(wt.path)}</span>
                    <span className="gp-ws-row-branch">
                      {wt.detached ? t("gitPage.worktreeDetached") : wt.branch}
                    </span>
                  </button>
                ))
              )}
            </Menu>
          )}
        </div>
        {graph?.root && (
          <span className="gp-root" title={graph.root}>
            {graph.root}
          </span>
        )}
        <span className="sp" />
        <button type="button" className="icon-btn" title={t("gitPage.refresh")} onClick={refresh}>
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="icon-btn" title={t("gitPage.close")} onClick={close}>
          <Icon name="xmark" size={15} />
        </button>
      </div>
      <div className="gp-body">
        {pair ? (
          <div className="gp-compare-slot">
            <FileCompare target={pair} onClose={() => setPair(null)} />
          </div>
        ) : (
          <div className="gp-center">
            <CommitGraph
              graph={graph}
              loading={loading}
              error={error}
              scope={scope}
              currentBranch={currentBranch}
              selected={selected}
              onSelect={selectCommit}
              onPickScope={pickScope}
              onLoadMore={() => setLimit((graph?.commits?.length ?? 0) + PAGE_STEP)}
            />
            <SplitHandle kind="center" />
            <BranchPanel
              local={branchLists.local}
              remotes={branchLists.remotes}
              tags={branchLists.tags}
              scope={scope}
              currentBranch={currentBranch}
              onPickScope={pickScope}
            />
          </div>
        )}
        <SplitHandle kind="rightw" />
        <aside className="gp-side">
          <div className="gp-col-head gp-side-head">
            <div className="gp-side-modes" role="group" aria-label={t("gitPage.sideMode")}>
              <button
                type="button"
                className={"gp-side-mode" + (sideMode === "worktree" ? " on" : "")}
                aria-pressed={sideMode === "worktree"}
                onClick={() => setSideMode("worktree")}
              >
                {t("gitPage.worktree")}
              </button>
              <button
                type="button"
                className={"gp-side-mode" + (sideMode === "commit" ? " on" : "")}
                aria-pressed={sideMode === "commit"}
                onClick={() => setSideMode("commit")}
              >
                {t("gitPage.detail")}
              </button>
            </div>
          </div>
          {sideMode === "commit" ? (
            <CommitDetail
              detail={detail}
              loading={detailLoading}
              error={detailError}
              fileView={fileView}
              onToggleFileView={() => setFileView((v) => (v === "flat" ? "tree" : "flat"))}
              selectedPath={pair?.origin === "commit" ? pair.path : null}
              onOpenFile={openCommitFile}
              onSelectCommit={selectCommit}
            />
          ) : (
            <WorktreeList
              files={worktreeFiles}
              loading={worktreeLoading}
              state={status?.cwd === cwd ? status.state : "NORMAL"}
              view={worktreeView}
              onToggleView={() => setWorktreeView((v) => (v === "flat" ? "tree" : "flat"))}
              selectedPath={pair?.origin === "worktree" ? pair.path : null}
              onOpen={openWorktreeFile}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
