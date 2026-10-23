// Lower half of the Git page's center column: three side-by-side lists —
// local branches, remote-tracking branches, tags — that scope the commit graph
// above. Rows nest by path segment ("feat/login" becomes "feat" → "login");
// picking a branch row reloads the graph for that ref, picking the
// "all branches" row clears the scope. Each list scrolls on its own.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { buildBranchTree, filterTree, type BranchNode } from "./branch-tree";

export default function BranchPanel({
  local,
  remotes,
  tags,
  scope,
  currentBranch,
  onPickScope,
}: {
  local: readonly string[];
  remotes: readonly string[];
  tags: readonly string[];
  /** Ref the graph is scoped to; "" = every ref. */
  scope: string;
  currentBranch: string;
  onPickScope: (ref: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  /** Collapsed tree nodes, keyed by full ref path. */
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);

  const localTree = useMemo(() => filterTree(buildBranchTree(local), query), [local, query]);
  const remoteTree = useMemo(() => filterTree(buildBranchTree(remotes), query), [remotes, query]);
  const tagTree = useMemo(() => filterTree(buildBranchTree(tags), query), [tags, query]);

  const toggleFolder = (full: string) =>
    setCollapsed((prev) => (prev.includes(full) ? prev.filter((v) => v !== full) : [...prev, full]));

  const branchRow = (node: BranchNode, depth: number): ReactNode => {
    const open = !collapsed.includes(node.full);
    const active = node.isBranch && scope === node.full;
    const isCurrent = node.isBranch && node.full === currentBranch;
    return (
      <div key={node.full} className="gp-branch-node">
        <div
          className={"gp-branch-row" + (active ? " on" : "") + (node.isBranch ? " pickable" : "")}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => node.isBranch && onPickScope(node.full)}
          role={node.isBranch ? "button" : undefined}
          tabIndex={node.isBranch ? 0 : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && node.isBranch) onPickScope(node.full);
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
        {open && node.children.map((child) => branchRow(child, depth + 1))}
      </div>
    );
  };

  const column = (label: string, count: number, body: ReactNode) => (
    <div className="gp-branch-col">
      <div className="gp-col-head">
        <span>{label}</span>
        <span className="gp-branch-count">{count}</span>
      </div>
      <div className="gp-branch-scroll">{body}</div>
    </div>
  );

  return (
    <section className="gp-branch-panel">
      <div className="gp-branch-cols">
        {column(
          t("gitPage.localBranches"),
          local.length,
          <>
            <button
              type="button"
              className={"gp-scope-row" + (scope === "" ? " on" : "")}
              onClick={() => onPickScope("")}
            >
              <Icon name="branch" size={12} />
              {t("gitPage.allBranches")}
            </button>
            {localTree.map((n) => branchRow(n, 0))}
          </>,
        )}
        {column(
          t("gitPage.remoteBranches"),
          remotes.length,
          remoteTree.length > 0 ? (
            remoteTree.map((n) => branchRow(n, 0))
          ) : (
            <div className="gp-empty">{t("gitPage.noRemote")}</div>
          ),
        )}
        {column(
          t("gitPage.tags"),
          tags.length,
          tagTree.length > 0 ? tagTree.map((n) => branchRow(n, 0)) : (
            <div className="gp-empty">{t("gitPage.noTags")}</div>
          ),
        )}
      </div>
      <input
        className="inp gp-branch-search"
        value={query}
        placeholder={t("gitPage.searchBranches")}
        onChange={(e) => setQuery(e.target.value)}
      />
    </section>
  );
}
