// Row grouping for the Git page's working-changes column. A file with both
// index and worktree edits (partially staged) belongs on both sides on purpose:
// each half opens its own compare pair (HEAD↔index, index↔disk), so folding it
// into one list would hide one of the two changes. Conflicts get their own group
// because neither half's pair is well defined for them.
import type { GitStatusFile } from "../../../types/frames";

/** Which half of the worktree list a row belongs to; also picks the compare pair. */
export type WorktreeHalf = "staged" | "unstaged" | "conflict";

export interface WorktreeRow {
  file: GitStatusFile;
  half: WorktreeHalf;
}

export interface WorktreeGroups {
  staged: WorktreeRow[];
  unstaged: WorktreeRow[];
  conflict: WorktreeRow[];
}

const byPath = (a: WorktreeRow, b: WorktreeRow) =>
  a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;

export function worktreeRows(files: readonly GitStatusFile[]): WorktreeGroups {
  const staged: WorktreeRow[] = [];
  const unstaged: WorktreeRow[] = [];
  const conflict: WorktreeRow[] = [];
  for (const file of files) {
    if (file.conflict) {
      // "UU" also carries a column that looks like a staged change; keeping it
      // out of both halves avoids opening a compare pair that cannot be defined.
      conflict.push({ file, half: "conflict" });
      continue;
    }
    if (file.staged) staged.push({ file, half: "staged" });
    if (file.unstaged || file.code === "??") unstaged.push({ file, half: "unstaged" });
  }
  return { staged: staged.sort(byPath), unstaged: unstaged.sort(byPath), conflict: conflict.sort(byPath) };
}

/** ` M` / `??` / `UU` → the single letter the row shows (untracked reads "U"). */
export function worktreeStatusLetter(file: GitStatusFile): string {
  if (file.code === "??") return "U";
  return (file.staged || file.unstaged || "M").slice(0, 1);
}
