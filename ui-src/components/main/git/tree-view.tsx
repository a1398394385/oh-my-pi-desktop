// Generic directory-tree renderer for the Git page's file lists: renders the
// shared tree shape (path-tree.ts) with caller-supplied row and folder
// renderers, so the commit list and the working-changes list share one tree
// layout (indentation + the 1px subtree guide).
import type { ReactNode } from "react";
import type { PathTree } from "./path-tree";

/** Indent step of one tree level (matches the commit list's original spacing). */
const STEP = 12;

function render<T>(
  tree: PathTree<T>,
  depth: number,
  base: number,
  renderRow: (item: T, depth: number) => ReactNode,
  renderDir: (name: string, depth: number) => ReactNode,
): ReactNode {
  return (
    <>
      {[...tree.dirs].map(([name, sub]) => (
        <div key={`dir:${name}`}>
          {renderDir(name, depth)}
          {/* The guide hangs under this folder's icon and stops at the end of its
              own subtree, which is the next sibling row. 6px = half the icon. */}
          <div className="gp-tree-children">
            <span className="gp-tree-guide" style={{ left: `${base + depth * STEP + 6}px` }} />
            {render(sub, depth + 1, base, renderRow, renderDir)}
          </div>
        </div>
      ))}
      {tree.files.map((item) => renderRow(item, depth))}
    </>
  );
}

export default function TreeView<T>({
  tree,
  base = 6,
  renderRow,
  renderDir,
}: {
  tree: PathTree<T>;
  /** Left padding of a depth-0 row (the guide line hangs 6px right of it). */
  base?: number;
  renderRow: (item: T, depth: number) => ReactNode;
  renderDir: (name: string, depth: number) => ReactNode;
}) {
  return <>{render(tree, 0, base, renderRow, renderDir)}</>;
}
