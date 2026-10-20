// Middle-column Git manager page (project row "more" → the Git entry): a
// read-only commit graph with lane topology, a branch/tag tree that scopes the
// log, and the selected commit's detail (full message, numstat file rows,
// ancestor count). Clicking a file row opens its patch in the right panel.
// Host side: host/rpc/git-graph.ts; transport + page memo: store/git-graph.ts.
// The page owns its render state locally — it never touches the session pool.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import Menu from "../sidebar/Menu";
import { pathBase, useAppStore } from "../../../store";
import {
  cachedGitGraph,
  fetchGitCommitDetail,
  fetchGitGraph,
  openCommitFileDiff,
} from "../../../store/git-graph";
import type { GitCommitDetailFrame, GitCommitFileWire, GitGraphFrame } from "../../../types/frames";
import { LANE_W, ROW_H, computeGraphRows } from "./graph-lanes";
import CommitRow, { fullDate } from "./CommitRow";
import { buildBranchTree, filterTree, type BranchNode } from "./branch-tree";
import FileList from "./file-list";

const INITIAL_LIMIT = 200;
const PAGE_STEP = 100;
/** Commit-filter debounce: a keystroke burst re-derives lanes for the whole loaded page. */
const FILTER_DEBOUNCE_MS = 150;
/** Rows rendered beyond each edge of the visible strip (~12 rows ≈ 336 px). */
const GRAPH_OVERSCAN = 12;
/** Date chip presets (commit author time, ms cutoffs computed per render). */
type DateRange = "all" | "today" | "7d" | "30d";
const DATE_CUTOFF_MS: Record<Exclude<DateRange, "all">, number> = {
  today: 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// ---------- page ----------

export default function GitPage() {
  const { t } = useTranslation();
  const cwd = useAppStore((s) => s.gitManage) ?? "";
  const [scope, setScope] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [branchQuery, setBranchQuery] = useState("");
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const [graph, setGraph] = useState<GitGraphFrame | null>(() => cachedGitGraph(cwd, "", INITIAL_LIMIT));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetailFrame | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [fileView, setFileView] = useState<"flat" | "tree">("flat");
  /** Graph filter bar (text/hash + branch/user/date chips + sort). */
  const [filterText, setFilterText] = useState("");
  const [filterRegex, setFilterRegex] = useState(false);
  const [filterCase, setFilterCase] = useState(false);
  const [filterAuthor, setFilterAuthor] = useState("");
  const [filterDate, setFilterDate] = useState<DateRange>("all");
  const [sortDesc, setSortDesc] = useState(true);
  const [chipMenu, setChipMenu] = useState<{ kind: "branch" | "user" | "date"; rect: DOMRect } | null>(null);
  /** In-menu search text (branch/user chips filter their rows as you type). */
  const [menuQuery, setMenuQuery] = useState("");
  /** Collapsed branch-list groups ("local" / "remote" / "tags"), separate from tree nodes. */
  const [groupCollapsed, setGroupCollapsed] = useState<readonly string[]>([]);
  const graphSeq = useRef(0);
  /** Debounced copy of filterText that actually feeds the row pipeline. */
  const [filterApplied, setFilterApplied] = useState("");
  /** Visible window of the commit list: scroll offset + viewport height. */
  const [graphView, setGraphView] = useState({ top: 0, height: 0 });
  const graphScrollRef = useRef<HTMLDivElement | null>(null);

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
    const id = setTimeout(() => setFilterApplied(filterText), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filterText]);

  // Only the visible window of rows is mounted (each row = 1 SVG strip; a full
  // 1000-row page would be thousands of SVG nodes); spacers keep the scrollbar stable.
  const syncGraphView = useCallback(() => {
    const el = graphScrollRef.current;
    if (!el) return;
    setGraphView((prev) =>
      prev.top === el.scrollTop && prev.height === el.clientHeight
        ? prev
        : { top: el.scrollTop, height: el.clientHeight },
    );
  }, []);
  useEffect(() => {
    const el = graphScrollRef.current;
    if (!el) return;
    syncGraphView();
    const ro = new ResizeObserver(syncGraphView);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncGraphView]);

  // Filter + sort pipeline over the loaded page. Every filter re-derives the
  // visible rows (and their lanes), so the graph stays continuous instead of
  // showing gaps where rows were hidden.
  const invalidRegex = useMemo(() => {
    if (!filterRegex || !filterApplied.trim()) return false;
    try {
      new RegExp(filterApplied);
      return false;
    } catch {
      return true;
    }
  }, [filterRegex, filterApplied]);

  const commits = useMemo(() => {
    const base = graph?.commits ?? [];
    const cutoff =
      filterDate === "all" ? 0 : Date.now() - DATE_CUTOFF_MS[filterDate];
    const q = filterApplied.trim();
    let test: (s: string) => boolean = () => true;
    if (q) {
      if (filterRegex && !invalidRegex) {
        const re = new RegExp(q, filterCase ? "" : "i");
        test = (s) => re.test(s);
      } else {
        // Invalid pattern: the box turns red and the text falls back to a literal
        // substring match, so typing `[` still narrows instead of blanking the list
        // for no visible reason.
        const needle = filterCase ? q : q.toLowerCase();
        test = (s) => (filterCase ? s : s.toLowerCase()).includes(needle);
      }
    }
    let list = base.filter(
      (c) =>
        (!filterAuthor || c.author === filterAuthor) &&
        (!cutoff || c.authorTime * 1000 >= cutoff) &&
        (!q || test(c.subject) || test(c.author) || test(c.oid)),
    );
    if (!sortDesc) list.reverse(); // host rows arrive newest-first (topo); ascending flips them
    return list;
  }, [graph, filterApplied, filterRegex, filterCase, filterAuthor, filterDate, sortDesc, invalidRegex]);

  // Keep a selection valid across reloads and filters: keep it when still
  // visible, else fall back to the first visible row.
  useEffect(() => {
    if (commits.length === 0) {
      setSelected(null);
      return;
    }
    setSelected((prev) => (prev && commits.some((c) => c.oid === prev) ? prev : commits[0].oid));
  }, [commits]);

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

  const rows = useMemo(() => computeGraphRows(commits), [commits]);
  // Fixed lane gutter shared by the header row and every commit row (the
  // widest lane map wins).
  const laneWidth = useMemo(
    () =>
      Math.max(
        4,
        rows.reduce((max, row) => Math.max(max, row.incoming.length, row.outgoing.length, row.nodeColumn + 1), 0),
      ) * LANE_W,
    [rows],
  );

  // Rows are a fixed 28 px with no margins (graph-lanes grid = CSS row grid),
  // so index math against the scroll offset is exact; a zero viewport height
  // (first paint, before the ResizeObserver reports) falls back to 640 px.
  const winStart = Math.max(0, Math.floor(graphView.top / ROW_H) - GRAPH_OVERSCAN);
  const winEnd = Math.min(
    commits.length,
    Math.ceil((graphView.top + (graphView.height || 640)) / ROW_H) + GRAPH_OVERSCAN,
  );

  const localTree = useMemo(
    () => filterTree(buildBranchTree(graph?.branches?.local ?? []), branchQuery),
    [graph, branchQuery],
  );
  const remoteTree = useMemo(
    () => filterTree(buildBranchTree(graph?.branches?.remotes ?? []), branchQuery),
    [graph, branchQuery],
  );
  const tagTree = useMemo(
    () => filterTree(buildBranchTree(graph?.branches?.tags ?? []), branchQuery),
    [graph, branchQuery],
  );

  /** Author chip options: distinct authors of the loaded page, in graph order. */
  const authorOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of graph?.commits ?? []) {
      if (c.author && !seen.has(c.author)) {
        seen.add(c.author);
        out.push(c.author);
      }
    }
    return out;
  }, [graph]);

  const dateLabel = (range: DateRange) =>
    range === "today"
      ? t("gitPage.dateToday")
      : range === "7d"
        ? t("gitPage.date7d")
        : range === "30d"
          ? t("gitPage.date30d")
          : t("gitPage.dateAll");

  /** Every ref the branch chip can scope to (locals, remotes, tags). */
  const branchRefs = useMemo(
    () => [
      ...(graph?.branches?.local ?? []),
      ...(graph?.branches?.remotes ?? []),
      ...(graph?.branches?.tags ?? []),
    ],
    [graph],
  );
  // Typing in the chip menu filters rows case-insensitively; the "all/any" rows
  // only make sense unfiltered, so they disappear while a query is active.
  const menuNeedle = menuQuery.trim().toLowerCase();
  const menuRefs = menuNeedle
    ? branchRefs.filter((ref) => ref.toLowerCase().includes(menuNeedle))
    : branchRefs;
  const menuAuthors = menuNeedle
    ? authorOptions.filter((author) => author.toLowerCase().includes(menuNeedle))
    : authorOptions;

  const toggleFolder = (full: string) => {
    setCollapsed((prev) => (prev.includes(full) ? prev.filter((v) => v !== full) : [...prev, full]));
  };

  /** Branch-list group folding ("local" / "remote" / "tags"), independent of tree nodes. */
  const toggleGroup = (key: string) => {
    setGroupCollapsed((prev) => (prev.includes(key) ? prev.filter((v) => v !== key) : [...prev, key]));
  };
  const groupOpen = (key: string) => !groupCollapsed.includes(key);

  const pickScope = (next: string) => {
    setScope(next);
    setLimit(INITIAL_LIMIT);
  };

  // Stable identity so memoized CommitRow rows skip re-render on scroll frames.
  const selectCommit = useCallback((oid: string) => setSelected(oid), []);

  /**
   * Open a filter-chip dropdown. The menu mounts one task later on purpose: it
   * closes itself on window clicks, and a trusted click is still propagating
   * when React flushes the update, so mounting in the same task would let the
   * new listener close the menu on the very click that opened it.
   */
  const openChipMenu = (kind: "branch" | "user" | "date", el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setMenuQuery("");
    setTimeout(() => setChipMenu({ kind, rect }), 0);
  };

  const close = () => useAppStore.getState().closeGitManage();

  /** Scope row: a ref name plus the parts/tree beneath it. */
  const branchRow = (node: BranchNode, depth: number, currentBranch: string): ReactNode => {
    const open = !collapsed.includes(node.full);
    const active = node.isBranch && scope === node.full;
    const isCurrent = node.isBranch && node.full === currentBranch;
    return (
      <div key={node.full} className="gp-branch-node">
        <div
          className={"gp-branch-row" + (active ? " on" : "") + (node.isBranch ? " pickable" : "")}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => node.isBranch && pickScope(node.full)}
          role={node.isBranch ? "button" : undefined}
          tabIndex={node.isBranch ? 0 : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && node.isBranch) pickScope(node.full);
          }}
        >
          {node.children.length > 0 ? (
            <span
              className={"gp-branch-caret" + (open ? " open" : "")}
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(node.full);
              }}
            >
              <Icon name="chevronRight" size={12} />
            </span>
          ) : (
            <span className="gp-branch-caret" />
          )}
          <span className="gp-branch-name">{node.name}</span>
          {isCurrent && <span className="gp-branch-tag">{t("gitPage.current")}</span>}
        </div>
        {open && node.children.map((child) => branchRow(child, depth + 1, currentBranch))}
      </div>
    );
  };

  const currentBranch = graph?.branch ?? "";
  const files = detail?.files ?? [];
  const detailOid = detail?.commit?.oid ?? "";
  const additions = detail?.additions ?? 0;
  const deletions = detail?.deletions ?? 0;
  const openFile = (file: GitCommitFileWire) =>
    openCommitFileDiff({ cwd, oid: detailOid, path: file.path, oldPath: file.oldPath });
  const style = { "--gp-lanes-w": `${laneWidth}px` } as CSSProperties;

  return (
    <div id="gitPage" style={style}>
      <div className="gp-head">
        <Icon name="branch" size={14} style={{ color: "var(--dim)" }} />
        <span className="gp-project" title={cwd}>
          {pathBase(cwd)}
        </span>
        {graph?.root && (
          <span className="gp-root" title={graph.root}>
            {graph.root}
          </span>
        )}
        <span className="sp" />
        <button
          type="button"
          className="icon-btn"
          title={t("gitPage.refresh")}
          onClick={() => runLoad(true)}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="icon-btn" title={t("gitPage.close")} onClick={close}>
          <Icon name="xmark" size={15} />
        </button>
      </div>
      <div className="gp-body">
        <aside className="gp-branches">
          <div className="gp-branch-scroll">
            <button
              type="button"
              className={"gp-branches-head" + (groupOpen("local") ? " open" : "")}
              onClick={() => toggleGroup("local")}
            >
              <span className="gp-branch-caret">
                <Icon name="chevronRight" size={12} />
              </span>
              {t("gitPage.localBranches")}
            </button>
            {groupOpen("local") && (
              <>
                <button
                  type="button"
                  className={"gp-scope-row" + (scope === "" ? " on" : "")}
                  onClick={() => pickScope("")}
                >
                  <Icon name="branch" size={12} />
                  {t("gitPage.allBranches")}
                </button>
                <div className="gp-branch-tree">{localTree.map((n) => branchRow(n, 0, currentBranch))}</div>
              </>
            )}
            {remoteTree.length > 0 && (
              <>
                <button
                  type="button"
                  className={"gp-branches-head" + (groupOpen("remote") ? " open" : "")}
                  onClick={() => toggleGroup("remote")}
                >
                  <span className="gp-branch-caret">
                    <Icon name="chevronRight" size={12} />
                  </span>
                  {t("gitPage.remoteBranches")}
                </button>
                {groupOpen("remote") && (
                  <div className="gp-branch-tree">{remoteTree.map((n) => branchRow(n, 0, currentBranch))}</div>
                )}
              </>
            )}
            {tagTree.length > 0 && (
              <>
                <button
                  type="button"
                  className={"gp-branches-head" + (groupOpen("tags") ? " open" : "")}
                  onClick={() => toggleGroup("tags")}
                >
                  <span className="gp-branch-caret">
                    <Icon name="chevronRight" size={12} />
                  </span>
                  {t("gitPage.tags")}
                </button>
                {groupOpen("tags") && (
                  <div className="gp-branch-tree">{tagTree.map((n) => branchRow(n, 0, currentBranch))}</div>
                )}
              </>
            )}
          </div>
          <input
            className="inp gp-branch-search"
            value={branchQuery}
            placeholder={t("gitPage.searchBranches")}
            onChange={(e) => setBranchQuery(e.target.value)}
          />
        </aside>
        <section className="gp-main">
          <div className="gp-filter">
            <div className={"gp-filter-box" + (invalidRegex ? " bad" : "")}>
              <Icon name="search" size={13} />
              <input
                className="gp-filter-inp"
                value={filterText}
                placeholder={t("gitPage.filterPlaceholder")}
                onChange={(e) => setFilterText(e.target.value)}
              />
              <button
                type="button"
                className={"gp-filter-flag" + (filterRegex ? " on" : "")}
                title={t("gitPage.filterRegex")}
                onClick={() => setFilterRegex((v) => !v)}
              >
                .*
              </button>
              <button
                type="button"
                className={"gp-filter-flag" + (filterCase ? " on" : "")}
                title={t("gitPage.filterCase")}
                onClick={() => setFilterCase((v) => !v)}
              >
                Cc
              </button>
            </div>
            <button
              type="button"
              className={"gp-chip" + (scope ? " on" : "")}
              onClick={(e) => openChipMenu("branch", e.currentTarget)}
            >
              <span className="gp-chip-k">{t("gitPage.filterBranch")}</span>
              <span className="gp-chip-v">{scope || currentBranch || "HEAD"}</span>
              {scope && (
                <span
                  className="gp-chip-x"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") pickScope("");
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    pickScope("");
                  }}
                >
                  <Icon name="xmark" size={11} />
                </span>
              )}
            </button>
            <button
              type="button"
              className={"gp-chip" + (filterAuthor ? " on" : "")}
              onClick={(e) => openChipMenu("user", e.currentTarget)}
            >
              <span className="gp-chip-k">{t("gitPage.filterUser")}</span>
              <span className="gp-chip-v">{filterAuthor || t("gitPage.filterAnyone")}</span>
              {filterAuthor && (
                <span
                  className="gp-chip-x"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setFilterAuthor("");
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilterAuthor("");
                  }}
                >
                  <Icon name="xmark" size={11} />
                </span>
              )}
            </button>
            <button
              type="button"
              className={"gp-chip" + (filterDate !== "all" ? " on" : "")}
              onClick={(e) => openChipMenu("date", e.currentTarget)}
            >
              <span className="gp-chip-k">{t("gitPage.filterDate")}</span>
              {filterDate !== "all" && <span className="gp-chip-v">{dateLabel(filterDate)}</span>}
              <Icon name="chevronDown" size={11} />
            </button>
            <span className="sp" />
            <button
              type="button"
              className={"gp-sort" + (sortDesc ? "" : " asc")}
              title={sortDesc ? t("gitPage.sortAsc") : t("gitPage.sortDesc")}
              onClick={() => setSortDesc((v) => !v)}
            >
              <Icon name="sort" size={14} />
            </button>
          </div>
          <div className="gp-table-head">
            <span className="gp-th-lanes">{t("gitPage.graph")}</span>
            <span className="gp-th-info">{t("gitPage.commitInfo")}</span>
            <span className="gp-th-author">{t("gitPage.author")}</span>
            <span className="gp-th-date">{t("gitPage.date")}</span>
          </div>
          <div className="gp-graph" ref={graphScrollRef} onScroll={syncGraphView}>
            {loading && !graph ? (
              <div className="gp-empty">{t("gitPage.loading")}</div>
            ) : error ? (
              <div className="gp-empty gp-error">{error}</div>
            ) : commits.length === 0 ? (
              <div className="gp-empty">
                {(graph?.commits?.length ?? 0) === 0 ? t("gitPage.empty") : t("gitPage.noMatch")}
              </div>
            ) : (
              <>
                {winStart > 0 && <div aria-hidden style={{ height: winStart * ROW_H }} />}
                {commits.slice(winStart, winEnd).map((commit, index) => (
                  <CommitRow
                    key={commit.oid}
                    commit={commit}
                    row={rows[winStart + index]}
                    laneWidth={laneWidth}
                    selected={selected === commit.oid}
                    currentBranch={currentBranch}
                    onSelect={selectCommit}
                  />
                ))}
                {winEnd < commits.length && <div aria-hidden style={{ height: (commits.length - winEnd) * ROW_H }} />}
                {graph?.hasMore && (
                  <button
                    type="button"
                    className="gp-more"
                    onClick={() => setLimit((graph?.commits?.length ?? 0) + PAGE_STEP)}
                  >
                    {t("gitPage.loadMore")}
                  </button>
                )}
              </>
            )}
          </div>
          {selected && (
            <div className="gp-detail">
              <div className="gp-detail-bar">
                {detailLoading ? (
                  <span className="gp-detail-hint">{t("gitPage.detailLoading")}</span>
                ) : detailError ? (
                  <span className="gp-detail-hint gp-error">{detailError}</span>
                ) : detail?.commit ? (
                  <>
                    <span className="gp-sha">{detail.commit.oid.slice(0, 7)}</span>
                    <Icon name="comment" size={12} style={{ color: "var(--faint)" }} />
                    <span>{detail.commit.author}</span>
                    <span className="gp-dot">·</span>
                    <span>{fullDate(detail.commit.authorTime)}</span>
                  </>
                ) : null}
                <span className="sp" />
                <button
                  type="button"
                  className={"gp-detail-toggle" + (detailOpen ? " open" : "")}
                  title={detailOpen ? t("gitPage.collapseDetail") : t("gitPage.expandDetail")}
                  onClick={() => setDetailOpen((v) => !v)}
                >
                  <Icon name="chevronDown" size={14} />
                </button>
              </div>
              {detailOpen && detail?.commit && (
                <div className="gp-detail-scroll">
                  <div className="gp-detail-subject">{detail.commit.subject}</div>
                  {detail.commit.body && <div className="gp-detail-body">{detail.commit.body}</div>}
                  <div className="gp-detail-sep" />
                  <div className="gp-detail-files">
                    <span>{t("gitPage.filesChanged", { n: files.length })}</span>
                    <span className="gp-add">+{additions}</span>
                    <span className="gp-del">-{deletions}</span>
                    <span className="sp" />
                    <button
                      type="button"
                      className="gp-file-view"
                      title={fileView === "flat" ? t("gitPage.viewTree") : t("gitPage.viewFlat")}
                      onClick={() => setFileView((v) => (v === "flat" ? "tree" : "flat"))}
                    >
                      <Icon name={fileView === "flat" ? "tree" : "list"} size={13} />
                    </button>
                  </div>
                  <div className="gp-file-list">
                    <FileList
                      files={files}
                      view={fileView}
                      binaryLabel={t("gitPage.fileBinary")}
                      onOpen={openFile}
                    />
                  </div>
                  {detail.commit.parents.length > 0 && (
                    <div className="gp-detail-parents">
                      <span className="gp-parents-label">{t("gitPage.parent")}</span>
                      {detail.commit.parents.map((parent) => (
                        <button
                          type="button"
                          key={parent}
                          className="gp-parent"
                          onClick={() => setSelected(parent)}
                        >
                          {parent.slice(0, 7)}
                        </button>
                      ))}
                    </div>
                  )}
                  {detail.commitCount !== null && detail.commitCount !== undefined && (
                    <div className="gp-detail-count">{t("gitPage.commitCount", { n: detail.commitCount })}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      {chipMenu && (
        <Menu
          place={(mr) => [
            Math.max(8, Math.min(chipMenu.rect.left, window.innerWidth - mr.width - 8)),
            Math.min(
              chipMenu.rect.bottom + 4,
              Math.max(8, window.innerHeight - mr.height - 8),
            ),
          ]}
          onClose={() => setChipMenu(null)}
        >
          <div className="gp-menu-search">
            <Icon name="search" size={13} />
            <input
              className="gp-menu-inp"
              value={menuQuery}
              placeholder={
                chipMenu.kind === "branch" ? t("gitPage.searchBranches") : t("gitPage.searchUser")
              }
              autoFocus
              spellCheck={false}
              onChange={(e) => setMenuQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setChipMenu(null);
              }}
            />
            {/* Kept mounted even when empty: a click that also unmounts its own
                target makes Menu's outside-click check miss it and closes the
                whole dropdown. */}
            <button
              type="button"
              className={"gp-menu-clear" + (menuQuery ? "" : " off")}
              title={t("gitPage.clearSearch")}
              onClick={() => setMenuQuery("")}
            >
              <Icon name="xmark" size={12} />
            </button>
          </div>
          <div className="gp-menu-scroll">
            {chipMenu.kind === "branch" && (
              <>
                {!menuNeedle && (
                  <button
                    className={scope === "" ? "on" : ""}
                    onClick={() => {
                      pickScope("");
                      setChipMenu(null);
                    }}
                  >
                    {t("gitPage.allBranches")}
                  </button>
                )}
                {menuRefs.map((ref) => (
                  <button
                    key={ref}
                    className={scope === ref ? "on" : ""}
                    onClick={() => {
                      pickScope(ref);
                      setChipMenu(null);
                    }}
                  >
                    {ref}
                  </button>
                ))}
                {menuRefs.length === 0 && <div className="gp-menu-empty">{t("gitPage.menuEmpty")}</div>}
              </>
            )}
            {chipMenu.kind === "user" && (
              <>
                {!menuNeedle && (
                  <button
                    className={filterAuthor === "" ? "on" : ""}
                    onClick={() => {
                      setFilterAuthor("");
                      setChipMenu(null);
                    }}
                  >
                    {t("gitPage.filterAnyone")}
                  </button>
                )}
                {menuAuthors.map((author) => (
                  <button
                    key={author}
                    className={filterAuthor === author ? "on" : ""}
                    onClick={() => {
                      setFilterAuthor(author);
                      setChipMenu(null);
                    }}
                  >
                    {author}
                  </button>
                ))}
                {menuAuthors.length === 0 && (
                  <div className="gp-menu-empty">{t("gitPage.menuEmpty")}</div>
                )}
              </>
            )}
            {chipMenu.kind === "date" &&
              (["all", "today", "7d", "30d"] as DateRange[]).map((range) => (
                <button
                  key={range}
                  className={filterDate === range ? "on" : ""}
                  onClick={() => {
                    setFilterDate(range);
                    setChipMenu(null);
                  }}
                >
                  {dateLabel(range)}
                </button>
              ))}
          </div>
        </Menu>
      )}
    </div>
  );
}
