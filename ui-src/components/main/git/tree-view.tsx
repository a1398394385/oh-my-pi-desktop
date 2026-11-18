// Generic directory-tree renderer for the Git page's file lists: renders the
// shared tree shape (path-tree.ts) with a caller-supplied row renderer, so the
// commit list and the working-changes list share one tree layout (indentation +
// the 1px subtree guide) and one folder fold state. Folders start expanded; the
// fold set lives here so neither caller has to plumb it.
import { useState, type ReactNode } from "react";
import Icon from "../../../Icon";
import type { PathTree } from "./path-tree";

/** Indent step of one tree level (matches the commit list's original spacing). */
const STEP = 12;

function render<T>(
  tree: PathTree<T>,
  prefix: string,
  depth: number,
  base: number,
  renderRow: (item: T, depth: number) => ReactNode,
  closed: ReadonlySet<string>,
  onToggle: (path: string) => void,
): ReactNode {
  return (
    <>
      {[...tree.dirs].map(([name, sub]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        const open = !closed.has(path);
        return (
          <div key={`dir:${path}`}>
            <button
              type="button"
              className="gp-dir"
              style={{ paddingLeft: `${base + depth * STEP}px` }}
              aria-expanded={open}
              onClick={() => onToggle(path)}
            >
              <span className={"gp-tree-caret" + (open ? " open" : "")}>
                <Icon name="chevronRight" size={10} />
              </span>
              <span className="gp-dir-name">{name}</span>
            </button>
            {open && (
              <div className="gp-tree-children">
                {/* The guide hangs under this folder's caret and stops at the end of
                    its own subtree, which is the next sibling row. 5px = half the caret. */}
                <span className="gp-tree-guide" style={{ left: `${base + depth * STEP + 5}px` }} />
                {render(sub, path, depth + 1, base, renderRow, closed, onToggle)}
              </div>
            )}
          </div>
        );
      })}
      {tree.files.map((item) => renderRow(item, depth))}
    </>
  );
}

export default function TreeView<T>({
  tree,
  base = 6,
  renderRow,
}: {
  tree: PathTree<T>;
  /** Left padding of a depth-0 row (the guide line hangs under the folder caret). */
  base?: number;
  renderRow: (item: T, depth: number) => ReactNode;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return <>{render(tree, "", 0, base, renderRow, closed, toggle)}</>;
}
