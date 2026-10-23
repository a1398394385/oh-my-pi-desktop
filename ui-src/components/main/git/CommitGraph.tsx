// Upper half of the Git page's center column: the commit graph with lane
// topology, its filter bar (text/regex/case, branch, author, date, sort) and
// the row virtualization. The filter re-derives lanes over the whole loaded
// page, so hidden rows never leave gaps in the graph.
//
// The page owns the loaded frame and the selection; this component owns
// everything that only affects how those rows are displayed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import Menu from "../sidebar/Menu";
import type { GitGraphFrame } from "../../../types/frames";
import { LANE_W, ROW_H, computeGraphRows } from "./graph-lanes";
import CommitRow from "./CommitRow";

/** Rows rendered beyond each edge of the visible strip (~12 rows ≈ 336 px). */
const GRAPH_OVERSCAN = 12;
/** Commit-filter debounce: a keystroke burst re-derives lanes for the whole loaded page. */
const FILTER_DEBOUNCE_MS = 150;
/** Date chip presets (commit author time, ms cutoffs computed per render). */
type DateRange = "all" | "today" | "7d" | "30d";
const DATE_CUTOFF_MS: Record<Exclude<DateRange, "all">, number> = {
  today: 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export default function CommitGraph({
  graph,
  loading,
  error,
  scope,
  currentBranch,
  selected,
  onSelect,
  onPickScope,
  onLoadMore,
}: {
  graph: GitGraphFrame | null;
  loading: boolean;
  error: string | null;
  scope: string;
  currentBranch: string;
  selected: string | null;
  onSelect: (oid: string) => void;
  onPickScope: (ref: string) => void;
  /** Loads one more page of commits (the "load more" row). */
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  const [filterText, setFilterText] = useState("");
  const [filterApplied, setFilterApplied] = useState("");
  const [filterRegex, setFilterRegex] = useState(false);
  const [filterCase, setFilterCase] = useState(false);
  const [filterAuthor, setFilterAuthor] = useState("");
  const [filterDate, setFilterDate] = useState<DateRange>("all");
  const [sortDesc, setSortDesc] = useState(true);
  const [chipMenu, setChipMenu] = useState<{ kind: "branch" | "user" | "date"; rect: DOMRect } | null>(null);
  /** In-menu search text (branch/user chips filter their rows as you type). */
  const [menuQuery, setMenuQuery] = useState("");
  /** Visible window of the commit list: scroll offset + viewport height. */
  const [graphView, setGraphView] = useState({ top: 0, height: 0 });
  const graphScrollRef = useRef<HTMLDivElement | null>(null);

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
    const cutoff = filterDate === "all" ? 0 : Date.now() - DATE_CUTOFF_MS[filterDate];
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
    const list = base.filter(
      (c) =>
        (!filterAuthor || c.author === filterAuthor) &&
        (!cutoff || c.authorTime * 1000 >= cutoff) &&
        (!q || test(c.subject) || test(c.author) || test(c.oid)),
    );
    if (!sortDesc) list.reverse(); // host rows arrive newest-first (topo); ascending flips them
    return list;
  }, [graph, filterApplied, filterRegex, filterCase, filterAuthor, filterDate, sortDesc, invalidRegex]);

  const rows = useMemo(() => computeGraphRows(commits), [commits]);
  // Fixed lane gutter shared by the header row and every commit row (the widest
  // lane map wins).
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

  const style = { "--gp-lanes-w": `${laneWidth}px` } as CSSProperties;

  return (
    <section className="gp-graph-panel" style={style}>
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
                if (e.key === "Enter") onPickScope("");
              }}
              onClick={(e) => {
                e.stopPropagation();
                onPickScope("");
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
                onSelect={onSelect}
              />
            ))}
            {winEnd < commits.length && <div aria-hidden style={{ height: (commits.length - winEnd) * ROW_H }} />}
            {graph?.hasMore && (
              <button type="button" className="gp-more" onClick={onLoadMore}>
                {t("gitPage.loadMore")}
              </button>
            )}
          </>
        )}
      </div>
      {chipMenu && (
        <Menu
          place={(mr) => [
            Math.max(8, Math.min(chipMenu.rect.left, window.innerWidth - mr.width - 8)),
            Math.min(chipMenu.rect.bottom + 4, Math.max(8, window.innerHeight - mr.height - 8)),
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
                      onPickScope("");
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
                      onPickScope(ref);
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
    </section>
  );
}
