// Commit-graph lane assignment + SVG lane strip for the Git page.
// Split out of GitPage so the page component stays under the file-size gate.
//
// The lane model is ported from dsh-git-graph's computeLanes: each lane waits
// for one commit; the first parent continues the node's lane, further parents
// start (or join) lanes to the right. Both the incoming and outgoing snapshots
// are kept per row so the renderer can draw continuous verticals, joins and
// forks.
import type { GitGraphCommitWire } from "../../../types/frames";

/** Fixed row height / lane step (px): the SVG lanes rely on the same grid as the CSS rows. */
export const ROW_H = 28;
export const LANE_W = 14;

export interface GraphRow {
  /** Lanes entering this row (before the node's lane was claimed). */
  incoming: (string | null)[];
  /** Lanes leaving this row (after the parents were placed). */
  outgoing: (string | null)[];
  nodeColumn: number;
  /** Lane column of each parent, in `parents` order. */
  parentColumns: number[];
  /** Lanes that also waited for this commit (merge joins): they end at the node. */
  joinColumns: number[];
}

export function computeGraphRows(rows: readonly GitGraphCommitWire[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const result: GraphRow[] = [];
  // Only commits present in this row set can be waited for: a filtered page has
  // parents it does not contain, and opening a lane for those would leave a
  // strand hanging through every following row (dozens of orphan verticals,
  // which reads as a dotted mess). A branch simply ends where its child leaves
  // the visible history.
  const present = new Set(rows.map((row) => row.oid));
  for (const row of rows) {
    const incoming = lanes.slice();
    let nodeColumn = lanes.findIndex((pending) => pending === row.oid);
    if (nodeColumn === -1) {
      lanes.push(row.oid);
      nodeColumn = lanes.length - 1;
    }
    // A second lane waiting for this commit is a merge join: it ends here.
    const joinColumns: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== nodeColumn && lanes[i] === row.oid) {
        joinColumns.push(i);
        lanes[i] = null;
      }
    }
    const parentColumns: number[] = [];
    const parents = row.parents.filter((parent) => present.has(parent));
    const [first, ...rest] = parents;
    lanes[nodeColumn] = null;
    if (first) {
      const existing = lanes.indexOf(first, 0);
      if (existing >= 0) parentColumns.push(existing);
      else {
        lanes[nodeColumn] = first;
        parentColumns.push(nodeColumn);
      }
    }
    for (const parent of rest) {
      const existing = lanes.indexOf(parent, 0);
      if (existing >= 0) parentColumns.push(existing);
      else {
        lanes.push(parent);
        parentColumns.push(lanes.length - 1);
      }
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    result.push({ incoming, outgoing: lanes.slice(), nodeColumn, parentColumns, joinColumns });
  }
  return result;
}

/**
 * One row's lane strip. Verticals run edge to edge so adjacent rows join into
 * continuous lines; a lane that ends at this row's node stops at mid-height.
 * Forked lanes bend out of the node with a cubic curve and join lanes bend back
 * into it, so the strip reads as continuous curves instead of right angles.
 */
export function LaneStrip({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW_H / 2;
  const nodeX = row.nodeColumn * LANE_W + LANE_W / 2;
  const laneX = (column: number) => column * LANE_W + LANE_W / 2;
  const columns = Math.max(row.incoming.length, row.outgoing.length, row.nodeColumn + 1);
  const merge = row.parentColumns.length > 1;
  return (
    <svg
      className="gp-lanes"
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {Array.from({ length: columns }, (_, c) => {
        const enters = c < row.incoming.length && row.incoming[c] !== null;
        const leaves = c < row.outgoing.length && row.outgoing[c] !== null;
        if (c === row.nodeColumn) {
          // node lane: the incoming half ends at the dot
          return <line key={`v${c}`} x1={laneX(c)} y1={0} x2={laneX(c)} y2={mid} className="gp-line" />;
        }
        // A lane consumed by this row (join) ends at the dot; a lane that
        // continues runs through; new lanes are drawn by their parent curve.
        if (enters) {
          return (
            <line
              key={`v${c}`}
              x1={laneX(c)}
              y1={0}
              x2={laneX(c)}
              y2={leaves ? ROW_H : mid}
              className="gp-line"
            />
          );
        }
        return null;
      })}
      {/* forks: node → parent lane, curving out and down to the row bottom */}
      {row.parentColumns
        .filter((column) => column !== row.nodeColumn)
        .map((column) => (
          <path
            key={`p${column}`}
            className="gp-line"
            d={`M ${nodeX} ${mid} C ${nodeX} ${mid + 9}, ${laneX(column)} ${mid + 3}, ${laneX(column)} ${ROW_H}`}
          />
        ))}
      {row.parentColumns[0] === row.nodeColumn && (
        <line x1={nodeX} y1={mid} x2={nodeX} y2={ROW_H} className="gp-line" />
      )}
      {/* joins: a second lane waiting for this commit curves into the node */}
      {row.joinColumns.map((column) => (
        <path
          key={`j${column}`}
          className="gp-line"
          d={`M ${laneX(column)} ${mid} C ${laneX(column)} ${mid - 7}, ${nodeX} ${mid - 7}, ${nodeX} ${mid}`}
        />
      ))}
      <circle cx={nodeX} cy={mid} r={merge ? 3 : 3.5} className={merge ? "gp-node-merge" : "gp-node"} />
    </svg>
  );
}
