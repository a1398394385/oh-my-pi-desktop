// Left column of the Git page: the project's uncommitted files, split into the
// staged and unstaged halves `git status` reports. Read-only — staging and
// discarding live elsewhere — but a row click opens the compare view for that
// file (HEAD/index vs index/worktree, depending on the half it sits in).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import type { GitOperationState, GitStatusFile } from "../../../types/frames";
import { type WorktreeHalf, type WorktreeRow, worktreeRows, worktreeStatusLetter } from "./worktree-rows";

/** Operation banner copy per host state (NORMAL never renders one). */
const OPERATION_LABEL: Record<GitOperationState, string> = {
  NORMAL: "gitPage.opNormal",
  REBASE: "gitPage.opRebase",
  MERGE: "gitPage.opMerge",
  CHERRY_PICK: "gitPage.opCherryPick",
  REVERT: "gitPage.opRevert",
  DETACHED_HEAD: "gitPage.opDetached",
};

export default function WorktreeList({
  files,
  loading,
  state,
  selectedPath,
  onOpen,
}: {
  files: readonly GitStatusFile[];
  loading: boolean;
  state: GitOperationState;
  /** Path currently open in the compare view (highlighted). */
  selectedPath: string | null;
  onOpen: (row: WorktreeRow) => void;
}) {
  const { t } = useTranslation();
  const [closed, setClosed] = useState<readonly WorktreeHalf[]>([]);
  const toggle = (half: WorktreeHalf) =>
    setClosed((prev) => (prev.includes(half) ? prev.filter((v) => v !== half) : [...prev, half]));
  const groups = worktreeRows(files);

  const group = (half: WorktreeHalf, label: string, rows: WorktreeRow[]) => {
    if (rows.length === 0) return null;
    const open = !closed.includes(half);
    return (
      <div className="gp-wt-group">
        <button
          type="button"
          className={"gp-branches-head" + (open ? " open" : "")}
          onClick={() => toggle(half)}
        >
          <span className="gp-branch-caret">
            <Icon name="chevronRight" size={12} />
          </span>
          {label}
          <span className="gp-wt-count">{rows.length}</span>
        </button>
        {open &&
          rows.map((row) => (
            <button
              type="button"
              key={`${half}:${row.file.path}`}
              className={"gp-wt-row" + (selectedPath === row.file.path ? " on" : "")}
              title={row.file.path}
              onClick={() => onOpen(row)}
            >
              <span className="gp-wt-name">{row.file.path}</span>
              <span className={"gp-wt-code" + (row.half === "conflict" ? " bad" : "")}>
                {worktreeStatusLetter(row.file)}
              </span>
            </button>
          ))}
      </div>
    );
  };

  return (
    <aside className="gp-worktree">
      {state !== "NORMAL" && <div className="gp-wt-state">{t(OPERATION_LABEL[state])}</div>}
      <div className="gp-wt-scroll">
        {loading && files.length === 0 ? (
          <div className="gp-empty">{t("common.loading")}</div>
        ) : files.length === 0 ? (
          <div className="gp-empty">{t("gitPage.worktreeClean")}</div>
        ) : (
          <>
            {group("conflict", t("gitPage.worktreeConflicts"), groups.conflict)}
            {group("staged", t("gitPage.staged"), groups.staged)}
            {group("unstaged", t("gitPage.unstaged"), groups.unstaged)}
          </>
        )}
      </div>
    </aside>
  );
}
