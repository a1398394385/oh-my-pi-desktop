// Git Diff page: toolbar above the list (commit message/commit/push) + file tree/flat view +
// inline write operations + per-file in-house lightweight diff detail (fixed rb-head +
// scrolling rb-scroll skeleton).
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, activeOpen, refreshGitDiff, pathBase } from "../../store";
import type { TimerHandle } from "../../store";
import Icon from "../../Icon";
import ConfirmDialog from "./ConfirmDialog";
import LightweightDiff from "../diff/LightweightDiff";
import { langOfPath } from "../../lib/highlighter";
import type { GitStatusFile } from "../../types/frames";

// A git diff file entry uses types/frames' GitStatusFile (staged/unstaged are status chars; empty string = none)
type GitFileEntry = GitStatusFile;

// Path tree node (product of buildTree)
interface GitTreeNode {
  dirs: Map<string, GitTreeNode>;
  files: GitFileEntry[];
}

// State shape of the discard confirm dialog (matches ConfirmDialog props)
interface DiscardConfirm {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  onDone: (yes: boolean) => void;
}

type GitWriteOp = "stage" | "unstage" | "discard" | "commit" | "push";

// ---------- git write-operation busy loop (old right.js gitBusy semantics) ----------
// In-flight write marker: { op, prev } (prev = the rightState.gitWrite reference before the
// operation started).
// The store doesn't guarantee the needed behavior on git write replies (the success path's
// refreshGitDiff sends no request when cwd is unchanged), so close the loop by polling the
// gitWrite reference every 120ms — local git ops are millisecond-scale, push seconds-scale, so
// the poll lives very briefly.
// busy is a module-level singleton, not a store field: set/clear swaps the reference and
// notifies lightweight subscribers (useGitBusy) —
// components subscribing to store selectors don't see module vars; the old global re-render
// (legacy notify bump) is replaced by this
let gitBusy: { op: GitWriteOp; prev: unknown } | null = null;
const gitBusySubs = new Set<() => void>();
/** Read gitBusy and subscribe to its changes (set/clear swaps the reference, re-rendering; getSnapshot returns the module var with a stable reference) */
function useGitBusy() {
  return useSyncExternalStore(
    (fn) => {
      gitBusySubs.add(fn);
      return () => gitBusySubs.delete(fn);
    },
    () => gitBusy,
  );
}
let gitBusyTimer: TimerHandle | undefined; // setInterval handle (reuses store's TimerHandle; undefined has the old null semantics)
const GIT_WRITE_REPLY: Record<GitWriteOp, string> = { stage: "git_staged", unstage: "git_unstaged", discard: "git_discarded", commit: "git_committed", push: "git_pushed" };
function startGitBusy(op: GitWriteOp) {
  gitBusy = { op, prev: useAppStore.getState().rightState.gitWrite };
  for (const fn of gitBusySubs) fn();
  clearInterval(gitBusyTimer);
  gitBusyTimer = setInterval(() => {
    const w = useAppStore.getState().rightState.gitWrite;
    if (!gitBusy || !w || w === gitBusy.prev || w.type !== GIT_WRITE_REPLY[gitBusy.op]) return;
    if (w.ok && gitBusy.op === "commit") {
      // Commit success clears the input (fresh rightState reference, formerly mutate + notify at the end)
      useAppStore.setState((st) => ({ rightState: { ...st.rightState, commitMsg: "" } }));
    }
    gitBusy = null;
    clearInterval(gitBusyTimer);
    refreshGitDiff(true); // force refetch (non-forced refresh sends no request when cwd is unchanged)
    for (const fn of gitBusySubs) fn();
  }, 120);
}

// Clicking a file row enters the detail: request the per-file diff
function requestFileDiff(s: { cwd: string }, filePath: string) {
  setBump({ selectedFile: filePath });
  useAppStore.setState((st) => ({ fileDiffCache: { ...st.fileDiffCache, loading: true, path: filePath } }));
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
}

export default function GitDiffPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const gitDiffCache = useAppStore((st) => st.gitDiffCache);
  const gitViewMode = useAppStore((st) => st.gitViewMode);
  const selectedFile = useAppStore((st) => st.selectedFile);
  const gitBusy = useGitBusy();
  const [confirm, setConfirm] = useState<DiscardConfirm | null>(null);
  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  if (!s.isGit) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.notGitRepoParen")}</div>;
  }
  if (selectedFile) {
    return <GdFileDetail />;
  }

  const busy = !!gitBusy;
  const hasStaged = gitDiffCache.files.some((f) => f.staged);
  // Discard is destructive: goes through a confirm (cwd taken from activeOpen at initiation,
  // aligned with the old gitCwd semantics)
  const onDiscard = (f: GitFileEntry) => {
    setConfirm({
      title: t("right.discardTitle"),
      message: t("right.discardMsg", { path: f.path }),
      confirmText: t("right.discard"),
      danger: true,
      onDone: (yes) => {
        setConfirm(null);
        if (!yes) return;
        const cwd = activeOpen()?.cwd;
        if (!cwd) return;
        send({ type: "git_discard", cwd, paths: [f.path] });
        startGitBusy("discard");
      },
    });
  };

  return (
    <>
      {/* Toolbar: commit message input (value kept in rightState.commitMsg across repaints) + commit (all staged) + push */}
      <div className="flex items-center gap-1.5 pt-0.5 px-2 pb-2">
        <input
          className="inp gd-commit-inp"
          type="text"
          placeholder={t("right.commitMsgPh")}
          value={rightState.commitMsg}
          onChange={(e) => {
            // Typing is a silent write: swap the reference without bump, leaving the old
            // useStore global subscription undisturbed (formerly a local force re-render, now
            // replaced by this subscription)
            useAppStore.setState((st) => ({ rightState: { ...st.rightState, commitMsg: e.target.value } }));
          }}
        />
        <button
          className={"save-btn" + (gitBusy?.op === "commit" ? " busy" : "")}
          title={t("right.commitStaged")}
          disabled={!rightState.commitMsg.trim() || !hasStaged || busy}
          onClick={() => {
            const message = rightState.commitMsg.trim();
            if (!message) return;
            send({ type: "git_commit", cwd: s.cwd, message }); // no paths = commit all staged
            startGitBusy("commit");
          }}
        >
          {gitBusy?.op === "commit" ? <Icon name="refresh" size={13} /> : t("right.commit")}
        </button>
        <button
          className={"save-btn" + (gitBusy?.op === "push" ? " busy" : "")}
          title={t("right.pushCurrent")}
          disabled={busy}
          onClick={() => {
            send({ type: "git_push", cwd: s.cwd });
            startGitBusy("push");
          }}
        >
          {gitBusy?.op === "push" ? <Icon name="refresh" size={13} /> : t("right.push")}
        </button>
      </div>
      {gitDiffCache.cwd !== s.cwd || gitDiffCache.loading ? (
        <div className="py-3 px-2.5 text-faint text-ui-base">{gitDiffCache.loading ? t("common.loading") : t("right.clickRefresh")}</div>
      ) : gitDiffCache.files.length === 0 ? (
        <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.worktreeClean")}</div>
      ) : gitViewMode === "flat" ? (
        gitDiffCache.files.map((f) => <GitFileRow key={f.path} f={f} displayPath={f.path} depth={0} onDiscard={onDiscard} />)
      ) : (
        <TreeLevel node={buildTree(gitDiffCache.files)} prefix="" depth={0} onDiscard={onDiscard} />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </>
  );
}

// File detail: back + path pinned at top, diff area scrolls (rendered by the in-house LightweightDiff component)
function GdFileDetail() {
  const { t } = useTranslation();
  const selectedFile = useAppStore((st) => st.selectedFile); // the entry if (selectedFile) already guards non-null, same as the original
  const fileDiffCache = useAppStore((st) => st.fileDiffCache);
  return (
    <>
      <div className="rb-head">
        <button
          className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text"
          onClick={() => {
            setBump({ selectedFile: null });
          }}
        >
          {t("right.backToList")}
        </button>
        <div className="text-ui-sm text-faint mb-1.5 break-all">{selectedFile}</div>
      </div>
      <div className="rb-scroll">
        {fileDiffCache.loading && fileDiffCache.path === selectedFile ? (
          <div className="py-3 px-2.5 text-faint text-ui-base">{t("common.loading")}</div>
        ) : fileDiffCache.path !== selectedFile || !fileDiffCache.diff ? (
          <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noDiffContent")}</div>
        ) : (
          <LightweightDiff diff={fileDiffCache.diff} lang={langOfPath(selectedFile)} className="fd-holder" />
        )}
      </div>
    </>
  );
}

// File row: status badge + file name + inline write ops (hover-revealed; shared by tree/flat views)
function GitFileRow({ f, displayPath, depth, onDiscard }: { f: GitFileEntry; displayPath: string; depth: number; onDiscard: (f: GitFileEntry) => void }) {
  const { t } = useTranslation();
  const gitBusy = useGitBusy();
  const busy = !!gitBusy;
  const cwd = () => activeOpen()?.cwd; // cwd resolution aligned with refreshGitDiff (activeOpen().cwd)
  // The pulse flag is read via getState at render (not subscribed): setting it rides the
  // expandedDirs write driving this render; the silent macrotask reset triggers no
  // subscription — the kids-in class survives until the next render so the entrance animation
  // isn't cut short (old notify semantics)
  const animateGdKids = useAppStore.getState().animateGdKids;
  return (
    <div
      className={"flex items-center gap-[5px] text-ui-sm py-[3px] px-2 rounded-[5px] min-w-0 cursor-pointer text-dim hover:bg-panel-2 hover:text-text group" + (animateGdKids ? " kids-in" : "")} /* style-token-ignore */
      style={{ paddingLeft: 4 + depth * 14 + 14 + "px", animationDelay: depth * 15 + "ms" }}
      title={f.path}
      onClick={() => {
        const s = activeOpen();
        if (s) requestFileDiff(s, f.path);
      }}
    >
      <span className={"gd-badge " + badgeClass(f.code)}>
        {f.code.includes("A") || f.code === "?" ? "A" : f.code.includes("D") ? "D" : "M"}
      </span>
      <span className="whitespace-nowrap overflow-hidden text-ellipsis text-text">{pathBase(displayPath)}</span>
      <span className="ml-auto flex-none inline-flex items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] ease-[var(--swift)] group-hover:opacity-100 focus-within:opacity-100">
        {f.unstaged && (
          <button
            className="gd-act"
            title={t("right.stage")}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation(); // don't trigger the row click's enter-detail
              const c = cwd();
              if (!c) return;
              send({ type: "git_stage", cwd: c, paths: [f.path] });
              startGitBusy("stage");
            }}
          >
            <Icon name="stage" />
          </button>
        )}
        {f.staged && (
          <button
            className="gd-act"
            title={t("right.unstage")}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              const c = cwd();
              if (!c) return;
              send({ type: "git_unstage", cwd: c, paths: [f.path] });
              startGitBusy("unstage");
            }}
          >
            <Icon name="unstage" />
          </button>
        )}
        <button
          className="gd-act danger"
          title={t("right.discardForever")}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard(f);
          }}
        >
          <Icon name="discard" />
        </button>
      </span>
    </div>
  );
}

// Tree view: directory rows (caret + name + count) + file rows, indented by depth; child rows
// play the entrance animation on expand
function TreeLevel({ node, prefix, depth, onDiscard }: { node: GitTreeNode; prefix: string; depth: number; onDiscard: (f: GitFileEntry) => void }) {
  const rightState = useAppStore((st) => st.rightState);
  // The pulse flag is read via getState at render (not subscribed): same as GitFileRow; the
  // silent reset doesn't cut the kids-in animation short
  const animateGdKids = useAppStore.getState().animateGdKids;
  const rows: ReactNode[] = [];
  for (const [seg, dir] of node.dirs) {
    const dirPath = prefix ? prefix + "/" + seg : seg;
    const expanded = rightState.expandedDirs.has(dirPath);
    rows.push(
      <div
        key={"d:" + dirPath}
        className={"flex items-center gap-[5px] text-ui-sm py-[3px] px-2 rounded-[5px] min-w-0 cursor-pointer text-dim hover:bg-panel-2 hover:text-text group" + (animateGdKids ? " kids-in" : "")} /* style-token-ignore */
        style={{ paddingLeft: 4 + depth * 14 + "px", animationDelay: depth * 15 + "ms" }}
        onClick={() => {
          // Expand/collapse swaps in a new Set + new rightState reference (subscribers notice
          // by reference); set the pulse animation flag on expand
          useAppStore.setState((st) => {
            const expandedDirs = new Set(st.rightState.expandedDirs);
            let animateGdKids = st.animateGdKids;
            if (expandedDirs.has(dirPath)) {
              expandedDirs.delete(dirPath);
            } else {
              expandedDirs.add(dirPath);
              animateGdKids = true; // child rows of this re-render play the entrance animation
            }
            return { rightState: { ...st.rightState, expandedDirs }, animateGdKids };
          });
          setTimeout(() => {
            useAppStore.setState({ animateGdKids: false }); // silent reset: no subscribers → no render; kids-in class stays (animation finishes), same semantics as the original
          }, 0);
        }}
      >
        <span className={"gd-caret" + (expanded ? " open" : "")}>
          <Icon name="chevronRight" size={10} />
        </span>
        <span className="whitespace-nowrap overflow-hidden text-ellipsis text-text">{seg}</span>
        <span className="text-ui-xs text-faint ml-auto shrink-0">{countFiles(dir)}</span>
      </div>,
    );
    if (expanded) rows.push(<TreeLevel key={"l:" + dirPath} node={dir} prefix={dirPath} depth={depth + 1} onDiscard={onDiscard} />);
  }
  for (const f of node.files) {
    rows.push(<GitFileRow key={f.path} f={f} displayPath={f.path} depth={depth} onDiscard={onDiscard} />);
  }
  return <>{rows}</>;
}

function badgeClass(code: string): string {
  if (code.includes("A") || code === "?") return "add";
  if (code.includes("D")) return "del";
  return "mod";
}

// Paths → directory tree (ordered dir Map + file arrays)
function buildTree(files: GitFileEntry[]): GitTreeNode {
  const root: GitTreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i])!; // assertion: the previous line guarantees existence (get right after has/set)
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node: GitTreeNode): number {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}
