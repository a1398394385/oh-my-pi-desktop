// Git Diff page: toolbar above the list (commit message/commit/push) + file tree/flat view +
// inline write operations + per-file in-house lightweight diff detail (fixed rb-head +
// scrolling rb-scroll skeleton).
import { useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, toast, activeOpen, refreshGitDiff, pathBase } from "../../../store";
import type { TimerHandle } from "../../../store";
import Icon from "../../../Icon";
import ConfirmDialog from "../../shared/ConfirmDialog";
import LightweightDiff, { isSelectableRow, parseDiff } from "../../diff/LightweightDiff";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";
import { commentsMarkdown } from "../git/comments";
import type { ReviewComment } from "../git/comments";
import { subscribeViewed, toggleViewed, viewedKey, viewedSnapshot } from "../git/git-viewed";
import { langOfPath } from "../../../lib/highlighter";
import type { GitStatusFile } from "../../../types/frames";

// A git diff file entry uses types/frames' GitStatusFile (staged/unstaged are status chars; empty string = none),
// plus the fields the host adds for rename display, generated-file folding and viewed marks. All optional, so a
// frame from a host that predates them still renders.
type GitFileEntry = GitStatusFile & { origPath?: string; generated?: boolean; fingerprint?: string };

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
  loadFileDiff(s, filePath);
}

// Fetch one file's diff without entering the detail (generated rows unfold in place first)
function loadFileDiff(s: { cwd: string }, filePath: string) {
  useAppStore.setState((st) => ({ fileDiffCache: { ...st.fileDiffCache, loading: true, path: filePath } }));
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
}

// Generated files (lockfiles, bundles, vendored trees) stay folded: their diff is
// requested only after an explicit unfold click. Unfold state is per cwd and
// module level (same shape as gitBusy) so it survives detail/list switches.
const generatedOpen = new Map<string, ReadonlySet<string>>();
const generatedSubs = new Set<() => void>();
function generatedSnapshot(cwd: string): ReadonlySet<string> {
  let open = generatedOpen.get(cwd);
  if (!open) generatedOpen.set(cwd, (open = new Set()));
  return open;
}
function subscribeGenerated(fn: () => void): () => void {
  generatedSubs.add(fn);
  return () => {
    generatedSubs.delete(fn);
  };
}
function toggleGenerated(cwd: string, path: string): void {
  const next = new Set(generatedSnapshot(cwd));
  if (!next.delete(path)) next.add(path);
  generatedOpen.set(cwd, next);
  for (const fn of generatedSubs) fn();
}
function useGeneratedOpen(cwd: string) {
  return useSyncExternalStore(subscribeGenerated, () => generatedSnapshot(cwd));
}
function useViewed(cwd: string) {
  return useSyncExternalStore(subscribeViewed, () => viewedSnapshot(cwd));
}

// Review comments, bucketed by cwd+path+rev: switching file or commit never
// shows another file's comments. They outlive the detail view and are cleared
// only by sending them.
const NO_LINES: ReadonlySet<number> = new Set();
const NO_COMMENTS: readonly ReviewComment[] = [];
const commentStore = new Map<string, readonly ReviewComment[]>();
const commentSubs = new Set<() => void>();
function commentBucket(cwd: string, path: string, rev?: string): string {
  return `${cwd}\u0000${path}\u0000${rev ?? ""}`;
}
function subscribeComments(fn: () => void): () => void {
  commentSubs.add(fn);
  return () => {
    commentSubs.delete(fn);
  };
}
function useComments(bucket: string) {
  return useSyncExternalStore(subscribeComments, () => commentStore.get(bucket) ?? NO_COMMENTS);
}
function setComments(bucket: string, list: readonly ReviewComment[]): void {
  commentStore.set(bucket, list);
  for (const fn of commentSubs) fn();
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
    return <div className="py-3 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  if (!s.isGit) {
    return <div className="py-3 text-faint text-ui-base">{t("right.notGitRepoParen")}</div>;
  }
  if (selectedFile) {
    // Keyed by path: switching files remounts the detail, which drops its line selection
    return <GdFileDetail key={selectedFile} />;
  }

  const busy = !!gitBusy;
  const hasStaged = gitDiffCache.files.some((f) => f.staged);
  const opState = gitDiffCache.state;
  // Unstage/discard/branch-switch are refused host-side while an operation is
  // open; hiding them here keeps the row honest about what will actually work.
  const opLocked = opState !== "NORMAL" && opState !== "DETACHED_HEAD";
  // Upstream divergence badge (MyGit's counts()): only meaningful for the cwd on display,
  // so a cached frame from another repo never shows here.
  const syncText =
    gitDiffCache.cwd === s.cwd
      ? [gitDiffCache.ahead > 0 ? `↑${gitDiffCache.ahead}` : "", gitDiffCache.behind > 0 ? `↓${gitDiffCache.behind}` : ""].filter(Boolean).join(" ")
      : "";
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
      {/* In-flight operation banner: a rebase/merge/cherry-pick leaves the repo half-finished,
          where unstage/discard/branch-switch silently do the wrong thing. Naming it is what
          makes the host's refusal legible instead of mysterious. */}
      {opState !== "NORMAL" && opState !== "DETACHED_HEAD" && (
        <div className="gd-opstate">
          <Icon name="warning" size={13} />
          <span>{t(`right.gitOpState.${opState}` as any)}</span>
        </div>
      )}
      {/* Toolbar: upstream sync badge + commit message input (value kept in rightState.commitMsg across repaints) + commit (all staged) + push */}
      <div className="flex items-center gap-1.5 pt-0.5 pb-2">
        {syncText && (
          <span className="text-ui-xs text-faint flex-none" title={gitDiffCache.upstream || undefined}>
            {syncText}
          </span>
        )}
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
        <div className="py-3 text-faint text-ui-base">{gitDiffCache.loading ? t("common.loading") : t("right.clickRefresh")}</div>
      ) : gitDiffCache.files.length === 0 ? (
        <div className="py-3 text-faint text-ui-base">{t("right.worktreeClean")}</div>
      ) : gitViewMode === "flat" ? (
        gitDiffCache.files.map((f) => <GitFileRow key={f.path} f={f} displayPath={f.path} depth={0} onDiscard={onDiscard} />)
      ) : (
        <TreeLevel node={buildTree(gitDiffCache.files)} prefix="" depth={0} onDiscard={onDiscard} />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </>
  );
}

// File detail: back + path + line-level ops pinned at top, diff area scrolls (rendered by the in-house
// LightweightDiff component)
function GdFileDetail() {
  const { t } = useTranslation();
  const selectedFile = useAppStore((st) => st.selectedFile); // the entry if (selectedFile) already guards non-null, same as the original
  const fileDiffCache = useAppStore((st) => st.fileDiffCache);
  const sessionId = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.sessionId : undefined));
  const file = useAppStore((st) => st.gitDiffCache.files.find((f) => f.path === st.selectedFile));
  const gitBusy = useGitBusy();
  const [selected, setSelected] = useState<ReadonlySet<number>>(NO_LINES);
  const [anchor, setAnchor] = useState<number | null>(null); // shift-click range start
  const [commentAt, setCommentAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [discardAsk, setDiscardAsk] = useState(false);
  const cwd = activeOpen()?.cwd ?? "";
  const bucket = commentBucket(cwd, selectedFile ?? "");
  const comments = useComments(bucket);
  const { rows } = useMemo(() => parseDiff(fileDiffCache.diff), [fileDiffCache.diff]);
  // New-side numbers actually picked out; a shift range only spans these, so it
  // never asks the host for lines the diff did not show (unchanged gaps between
  // hunks) nor for context lines, which carry no change of their own.
  const lineNumbers = useMemo(
    () => rows.filter((r) => isSelectableRow(r)).map((r) => r.no as number),
    [rows],
  );
  const lineList = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);
  const busy = !!gitBusy;
  // The host truncates file_diff at 500k chars; staging lines off a partial diff
  // would pick the wrong ones, so line ops are refused rather than guessed.
  const truncated = fileDiffCache.diff.length >= 500_000;
  const linesHint = truncated ? t("gitPage.linesTruncated") : lineList.length ? "" : t("gitPage.selectLinesHint");

  const toggleLine = (newNo: number, extend: boolean) => {
    const from = extend && anchor != null ? lineNumbers.indexOf(anchor) : -1;
    const to = lineNumbers.indexOf(newNo);
    setSelected((cur) => {
      const next = new Set(cur);
      if (from >= 0 && to >= 0) {
        for (const n of lineNumbers.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(n);
      } else if (!next.delete(newNo)) {
        next.add(newNo);
      }
      return next;
    });
    if (!extend) setAnchor(newNo);
  };

  const sendLines = (op: "stage" | "unstage" | "discard") => {
    if (!cwd || !selectedFile || lineList.length === 0) return;
    if (op === "discard") send({ type: "git_discard", cwd, path: selectedFile, lines: lineList });
    else if (op === "unstage") send({ type: "git_unstage", cwd, path: selectedFile, lines: lineList });
    else send({ type: "git_stage", cwd, path: selectedFile, lines: lineList });
    startGitBusy(op);
    setSelected(NO_LINES);
    setAnchor(null);
  };

  const saveComment = () => {
    const body = draft.trim();
    if (commentAt == null || !body || !selectedFile) return;
    const code = rows.filter((r) => r.kind !== "removed" && r.no === commentAt).map((r) => r.text);
    setComments(bucket, [...comments, { path: selectedFile, lines: String(commentAt), code, body }]);
    setCommentAt(null);
  };

  return (
    <>
      <div className="rb-head">
        <button
          className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-hover-fill hover:text-text"
          onClick={() => {
            setBump({ selectedFile: null });
          }}
        >
          {t("right.backToList")}
        </button>
        <div className="text-ui-sm text-faint mb-1.5 break-all">{selectedFile}</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!!file?.unstaged && (
            <button
              className="save-btn"
              title={linesHint || t("gitPage.stageSelected")}
              disabled={busy || truncated || lineList.length === 0}
              onClick={() => sendLines("stage")}
            >
              {t("gitPage.stageSelected")}
            </button>
          )}
          {!!file?.staged && (
            <button
              className="save-btn"
              title={linesHint || t("gitPage.unstageSelected")}
              disabled={busy || truncated || lineList.length === 0}
              onClick={() => sendLines("unstage")}
            >
              {t("gitPage.unstageSelected")}
            </button>
          )}
          {!!file?.unstaged && (
            <button
              className="save-btn danger"
              title={linesHint || t("gitPage.discardSelected")}
              disabled={busy || truncated || lineList.length === 0}
              onClick={() => setDiscardAsk(true)}
            >
              {t("gitPage.discardSelected")}
            </button>
          )}
          <button
            className="save-btn ml-auto"
            title={t("gitPage.sendToAgent", { n: comments.length })}
            disabled={comments.length === 0 || !sessionId}
            onClick={() => {
              if (!sessionId) return;
              send({ type: "prompt", sessionId, text: commentsMarkdown(comments) });
              setComments(bucket, NO_COMMENTS);
              toast(t("gitPage.commentsSent"));
            }}
          >
            {t("gitPage.sendToAgent", { n: comments.length })}
          </button>
        </div>
      </div>
      <div className="rb-scroll">
        {fileDiffCache.loading && fileDiffCache.path === selectedFile ? (
          <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>
        ) : fileDiffCache.path !== selectedFile || !fileDiffCache.diff ? (
          <div className="py-3 text-faint text-ui-base">{t("right.noDiffContent")}</div>
        ) : (
          <LightweightDiff
            diff={fileDiffCache.diff}
            lang={langOfPath(selectedFile)}
            className="fd-holder"
            selectable
            selected={selected}
            onToggleLine={toggleLine}
            comments={comments.map((c) => ({ line: parseInt(c.lines, 10), body: c.body }))}
            onAddComment={(newNo: number) => {
              setDraft("");
              setCommentAt(newNo);
            }}
            folded={false}
          />
        )}
      </div>
      {commentAt != null && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setCommentAt(null);
          }}
        >
          <DialogContent className="confirm-box" style={{ width: "480px", maxWidth: "92vw" }}>
            <DialogTitle className="confirm-title">{t("gitPage.commentTitle", { line: commentAt })}</DialogTitle>
            <Textarea
              className="w-full mt-3"
              rows={4}
              autoFocus
              value={draft}
              placeholder={t("gitPage.commentPh")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveComment();
              }}
            />
            <DialogFooter className="confirm-actions mt-4">
              <button className="confirm-btn" onClick={() => setCommentAt(null)}>
                {t("common.cancel")}
              </button>
              <button className="confirm-btn" disabled={!draft.trim()} onClick={saveComment}>
                {t("gitPage.commentSave")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {discardAsk && (
        <ConfirmDialog
          title={t("gitPage.discardSelected")}
          message={t("gitPage.discardLinesMsg", { n: lineList.length })}
          confirmText={t("right.discard")}
          danger
          onDone={(yes) => {
            setDiscardAsk(false);
            if (yes) sendLines("discard");
          }}
        />
      )}
    </>
  );
}

// File row: viewed toggle + status badge + file name + inline write ops (hover-revealed; shared by tree/flat views)
function GitFileRow({ f, displayPath, depth, onDiscard }: { f: GitFileEntry; displayPath: string; depth: number; onDiscard: (f: GitFileEntry) => void }) {
  const { t } = useTranslation();
  const gitBusy = useGitBusy();
  const busy = !!gitBusy;
  // Unstage/discard/branch-switch are refused host-side while an operation is
  // open; hiding them here keeps the row honest about what will actually work.
  const opLocked = useAppStore((s) => s.gitDiffCache.state !== "NORMAL" && s.gitDiffCache.state !== "DETACHED_HEAD");
  const cwd = activeOpen()?.cwd ?? ""; // cwd resolution aligned with refreshGitDiff (activeOpen().cwd)
  const viewedSet = useViewed(cwd);
  const generatedSet = useGeneratedOpen(cwd);
  const fingerprint = f.fingerprint ?? "";
  const viewed = !!fingerprint && viewedSet.has(viewedKey(cwd, f.path, fingerprint));
  // Generated rows open folded: the first click unfolds (and fetches the diff),
  // the next one opens the detail.
  const folded = !!f.generated && !generatedSet.has(f.path);
  // The pulse flag is read via getState at render (not subscribed): setting it rides the
  // expandedDirs write driving this render; the silent macrotask reset triggers no
  // subscription — the kids-in class survives until the next render so the entrance animation
  // isn't cut short (old notify semantics)
  const animateGdKids = useAppStore.getState().animateGdKids;
  return (
    <div
      className={
        "flex items-center gap-[5px] text-ui-sm py-[3px] px-2 rounded-[5px] min-w-0 cursor-pointer hover:bg-hover-fill hover:text-text group" + /* style-token-ignore */
        (viewed ? " text-faint" : " text-dim") +
        (animateGdKids ? " kids-in" : "")
      }
      style={{ paddingLeft: 4 + depth * 14 + 14 + "px", animationDelay: depth * 15 + "ms" }}
      title={folded ? t("gitPage.generatedHint") : f.path}
      onClick={() => {
        const s = activeOpen();
        if (!s) return;
        if (folded) {
          toggleGenerated(s.cwd, f.path);
          loadFileDiff(s, f.path);
          return;
        }
        requestFileDiff(s, f.path);
      }}
    >
      {f.generated && (
        <span className={"gd-caret" + (folded ? "" : " open")}>
          <Icon name="chevronRight" size={10} />
        </span>
      )}
      {/* Stage stays enabled on a conflict: `git add` is how you mark it resolved.
          Unstage/discard are refused host-side mid-operation and are hidden rather
          than left to fail with a raw git error. */}
      <span className={"gd-badge " + badgeClass(f.code, !!f.conflict)}>{badgeLetter(f.code, !!f.conflict)}</span>
      <span className={"whitespace-nowrap overflow-hidden text-ellipsis " + (viewed ? "text-faint" : "text-text")}>{pathBase(displayPath)}</span>
      {/* porcelain v2 rename record: the old name, kept on one line like the name itself */}
      {f.origPath && f.origPath !== f.path && (
        <span className="text-ui-xs text-faint whitespace-nowrap overflow-hidden text-ellipsis flex-none">← {f.origPath}</span>
      )}
      {f.generated && <span className="text-ui-xs text-faint flex-none">{t("gitPage.generated")}</span>}
      <button
        className={"gd-act" + (viewed ? " on" : "")}
        title={viewed ? t("gitPage.unmarkViewed") : t("gitPage.markViewed")}
        aria-pressed={viewed}
        disabled={!fingerprint}
        onClick={(e) => {
          e.stopPropagation(); // don't trigger the row click's unfold/enter-detail
          if (fingerprint) toggleViewed(cwd, f.path, fingerprint);
        }}
      >
        <Icon name="check" />
      </button>
      <span className="ml-auto flex-none inline-flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-snap)] ease-[var(--swift)] group-hover:opacity-100 focus-within:opacity-100">
        {f.unstaged && (
          <button
            className="gd-act"
            title={t("right.stage")}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation(); // don't trigger the row click's enter-detail
              if (!cwd) return;
              send({ type: "git_stage", cwd, paths: [f.path] });
              startGitBusy("stage");
            }}
          >
            <Icon name="stage" />
          </button>
        )}
        {!opLocked && f.staged && (
          <button
            className="gd-act"
            title={t("right.unstage")}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              if (!cwd) return;
              send({ type: "git_unstage", cwd, paths: [f.path] });
              startGitBusy("unstage");
            }}
          >
            <Icon name="unstage" />
          </button>
        )}
        {!opLocked && (
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
        )}
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
        className={"flex items-center gap-[5px] text-ui-sm py-[3px] px-2 rounded-[5px] min-w-0 cursor-pointer text-dim hover:bg-hover-fill hover:text-text group" + (animateGdKids ? " kids-in" : "")} /* style-token-ignore */
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

// Porcelain XY, read by column: X is the index/staged state, Y the worktree
// state. The old version tested `code.includes("A")` / `=== "?"` against a
// trimmed 2-char string, so "??" (untracked) never matched "?" and every new
// file rendered as "M". Untracked is a new file by definition; a conflict gets
// its own letter because neither column means anything on its own there.
function primaryStatus(code: string, conflict: boolean): string {
  if (conflict) return "C";
  if (code === "??" || code === "!!") return "A";
  const x = code[0] ?? " ";
  if (x !== " ") return x;
  const y = code[1] ?? " ";
  return y === " " ? "M" : y;
}

function badgeLetter(code: string, conflict: boolean): string {
  return primaryStatus(code, conflict);
}

function badgeClass(code: string, conflict: boolean): string {
  switch (primaryStatus(code, conflict)) {
    case "A":
      return "add";
    case "D":
      return "del";
    case "C":
      return "conflict";
    default:
      return "mod";
  }
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
