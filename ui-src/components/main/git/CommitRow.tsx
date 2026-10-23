// One commit row of the Git page graph list, memoized: scrolling swaps the
// rendered window, and the rows that stay mounted keep identical props (the
// commit/row objects are reference-stable), so only the two rows whose
// selection toggle changed re-render. Date formatting lives here because the
// row is its only consumer besides the detail bar's fullDate.
import { memo } from "react";
import type { GitGraphCommitWire } from "../../../types/frames";
import { LaneStrip, type GraphRow } from "./graph-lanes";

function twoDigit(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date column: MM/DD (the full timestamp lives in the title attribute). */
export function shortDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${twoDigit(d.getMonth() + 1)}/${twoDigit(d.getDate())}`;
}

export function fullDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${twoDigit(d.getMonth() + 1)}-${twoDigit(d.getDate())} ${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}`;
}

interface CommitRowProps {
  commit: GitGraphCommitWire;
  row: GraphRow | undefined;
  laneWidth: number;
  selected: boolean;
  currentBranch: string;
  onSelect: (oid: string) => void;
}

function CommitRowImpl({ commit, row, laneWidth, selected, currentBranch, onSelect }: CommitRowProps) {
  if (!row) return null;
  return (
    <button
      type="button"
      className={"gp-row" + (selected ? " on" : "")}
      onClick={() => onSelect(commit.oid)}
      data-oid={commit.oid}
    >
      <LaneStrip row={row} width={laneWidth} />
      <span className="gp-subject">
        {commit.refs.map((ref) => (
          <span key={ref} className={"gp-ref" + (ref === currentBranch ? " current" : "")}>
            {ref}
          </span>
        ))}
        <span className="gp-subject-text" title={commit.subject}>
          {commit.subject}
        </span>
      </span>
      <span className="gp-author">{commit.author}</span>
      <span className="gp-date" title={fullDate(commit.authorTime)}>
        {shortDate(commit.authorTime)}
      </span>
    </button>
  );
}

const CommitRow = memo(CommitRowImpl);
export default CommitRow;
