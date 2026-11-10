// Run-scoped file-change tracking and revert (the ZCode-style turn-final changes card).
//
// Capture: edit/write/apply_patch tool calls snapshot every touched file before (pre-read at
// tool_execution_start, authoritative oldText from the edit tool's result details when present)
// and after (post-read at tool_execution_end). Only the run's FIRST before and LAST after per
// file survive, so the card shows the run's net change. At terminal agent_end the net diff is
// recomputed from the snapshots, no-op files are dropped, snapshots are written under the
// session artifacts dir (run-changes/<changeId>/<idx>.before|.after), and one custom entry is
// appended to the session journal — the single source of truth for both the reload path
// (translate-history) and the revert/diff RPCs (the in-memory tracker is never consulted there).
//
// Revert rule: only the run that LAST changed a file (latest non-reverted record across the
// journal) may revert it, and the on-disk content must still equal that run's after snapshot —
// later edits by other runs, bash, or the user all fail closed. Reverting pops the stack, so the
// previous run's change to the same file becomes revertible again (chained undo).
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { collectFiles, isDevicePath, diffStats } from "./translate-tool.ts";
import { entryBus, stampEvent } from "./state.ts";
import type { PoolEntry } from "./state.ts";
import type { RunChangeFile } from "./wire/payloads.ts";
import { hostI18n } from "./i18n/host.ts";
import { safeStderr } from "./stderr.ts";

export const RUN_CHANGES_CUSTOM_TYPE = "desktopRunChanges";
export const RUN_REVERT_CUSTOM_TYPE = "desktopRunRevert";
const MAX_SNAPSHOT_BYTES = 2_000_000;
const TRACKED_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };

type Snapshot = string | null | undefined; // null = file absent; undefined = unreadable/oversized

type PendingFile = {
  abs: string;
  touched: boolean; // a non-error tool end mutated it this run
  beforeText?: string | null; // edit tool's own oldText (authoritative, beats the pre-read)
  beforeRead?: Promise<Snapshot>;
  afterText?: string | null; // edit tool's newText (fallback when the post-read fails)
  afterRead?: Promise<Snapshot>;
  added: number; // per-call accumulated stats, used only when snapshots are unavailable
  removed: number;
};

type RunTracker = { files: Map<string, PendingFile> };

// Keyed by entry (not stored on PoolEntry) to keep state.ts free of a back-edge.
const trackers = new WeakMap<PoolEntry, RunTracker>();

/** Read a file for snapshotting: utf8 text, null when absent, undefined when not a regular
 *  file / over the size cap / unreadable. */
async function readSnapshot(abs: string): Promise<Snapshot> {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
  try {
    return await fsp.readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

function targetPaths(entry: PoolEntry, name: string, args: unknown): string[] {
  if (!TRACKED_TOOLS[name]) return [];
  const out: string[] = [];
  for (const p of collectFiles(name, args)) {
    if (isDevicePath(p)) continue;
    const abs = path.resolve(entry.cwd, p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export function trackRunToolStart(entry: PoolEntry, name: string, args: unknown): void {
  const paths = targetPaths(entry, name, args);
  if (!paths.length) return;
  let tracker = trackers.get(entry);
  if (!tracker) {
    tracker = { files: new Map() };
    trackers.set(entry, tracker);
  }
  for (const abs of paths) {
    if (tracker.files.has(abs)) continue; // the run's first before wins
    // The pre-read races the tool's own write (same residual race as translate.ts's
    // pendingWrites): the edit tool's oldText supersedes it where available, and a lost race
    // surfaces as before===after, which finalize drops as a no-op instead of reverting wrongly.
    tracker.files.set(abs, { abs, touched: false, beforeRead: readSnapshot(abs), added: 0, removed: 0 });
  }
}

// Per-file old/new text from the edit tool's result details (single-file oldText/newText or
// perFileResults; write results carry none). Snapshots past the base's 32KB budget are pruned
// (snapshotsPruned) and simply arrive absent — the pre/post-reads cover that case.
function detailTexts(result: unknown): { single?: { oldText?: unknown; newText?: unknown }; perFile?: Array<{ path?: unknown; oldText?: unknown; newText?: unknown }> } {
  const d = (result as { details?: unknown } | null | undefined)?.details ?? result;
  if (!d || typeof d !== "object") return {};
  const rec = d as { oldText?: unknown; newText?: unknown; perFileResults?: unknown };
  return {
    single: { oldText: rec.oldText, newText: rec.newText },
    perFile: Array.isArray(rec.perFileResults) ? (rec.perFileResults as Array<{ path?: unknown; oldText?: unknown; newText?: unknown }>) : undefined,
  };
}

export function trackRunToolEnd(
  entry: PoolEntry,
  name: string,
  args: unknown,
  result: unknown,
  isError: boolean,
  stats?: { added?: number; removed?: number },
): void {
  const tracker = trackers.get(entry);
  if (!tracker || isError) return;
  const paths = targetPaths(entry, name, args);
  if (!paths.length) return;
  const details = detailTexts(result);
  for (const abs of paths) {
    const p = tracker.files.get(abs);
    if (!p) continue; // no start seen (e.g. attached mid-run): skip, no reliable before
    const perFile = details.perFile?.find((f) => typeof f?.path === "string" && path.resolve(entry.cwd, f.path as string) === abs);
    const oldText = perFile ? perFile.oldText : details.single?.oldText;
    const newText = perFile ? perFile.newText : details.single?.newText;
    if (!p.touched && (typeof oldText === "string" || oldText === null)) p.beforeText = oldText as string | null;
    if (typeof newText === "string" || newText === null) p.afterText = newText as string | null;
    p.touched = true;
    p.added += stats?.added ?? 0;
    p.removed += stats?.removed ?? 0;
    p.afterRead = readSnapshot(abs); // the run's last after wins
  }
}

// Snapshot layout contract (shared by the writer and the RPC readers): session artifacts dir
// (SDK getArtifactsDir, falling back to the journal path sans .jsonl) /run-changes/<changeId>.
function snapshotDir(entry: PoolEntry, changeId: string): string {
  const artifacts = entry.manager?.getArtifactsDir?.() ?? entry.path.replace(/\.jsonl$/, "");
  return path.join(artifacts, "run-changes", changeId);
}

/** Terminal agent_end: settle the tracker, persist snapshots + the journal record, and hand the
 *  card payload back for the run_changes frame. No anchor (a run without assistant text) still
 *  persists — later runs' top-of-stack checks need the record even though no card renders. */
export async function finalizeRunChanges(
  entry: PoolEntry,
  anchor: string | undefined,
  emit: (anchor: string, files: RunChangeFile[]) => void,
): Promise<void> {
  const tracker = trackers.get(entry);
  trackers.delete(entry);
  if (!tracker) return;
  const touched = [...tracker.files.values()].filter((p) => p.touched);
  if (!touched.length) return;

  const files: RunChangeFile[] = [];
  const snapshots: Array<{ idx: number; before?: string; after?: string }> = [];
  for (const p of touched) {
    const before: Snapshot = p.beforeText !== undefined ? p.beforeText : await p.beforeRead;
    const afterRead = await p.afterRead;
    const after: Snapshot = afterRead !== undefined ? afterRead : p.afterText;
    if (before !== undefined && after !== undefined && before === after) continue; // no net change
    const noSnapshot = before === undefined || after === undefined || (before ?? "").includes("\0") || (after ?? "").includes("\0");
    const f: RunChangeFile = { path: p.abs, added: p.added, removed: p.removed };
    if (before === null) f.created = true;
    if (after === null) f.deleted = true;
    if (noSnapshot) f.noSnapshot = true;
    else {
      // Net stats from the full snapshots (per-call sums double-count overlapping edits)
      try {
        const diff = editDiffString(before ?? "", after ?? "", p.abs)?.diff;
        if (typeof diff === "string") Object.assign(f, diffStats(diff));
      } catch {
        // keep the accumulated stats
      }
      const idx = files.length;
      snapshots.push({ idx, ...(before !== null ? { before } : {}), ...(after !== null ? { after } : {}) });
    }
    files.push(f);
  }
  if (!files.length) return;

  const changeId = randomUUID();
  if (snapshots.length) {
    const dir = snapshotDir(entry, changeId);
    await fsp.mkdir(dir, { recursive: true });
    await Promise.all(
      snapshots.flatMap((s) => [
        ...(s.before !== undefined ? [fsp.writeFile(path.join(dir, `${s.idx}.before`), s.before, "utf8")] : []),
        ...(s.after !== undefined ? [fsp.writeFile(path.join(dir, `${s.idx}.after`), s.after, "utf8")] : []),
      ]),
    );
  }
  entry.manager.appendCustomEntry(RUN_CHANGES_CUSTOM_TYPE, { changeId, anchor, files });
  if (anchor) emit(anchor, files);
}

/** Terminal agent_end hook for session-entry-core (one call line, fire-and-forget): the anchor
 *  is the run-tail assistant entryId, already backfilled onto the transcript by translateEvent.
 *  Emits run_changes to every attached UI; failures log and never break the run. */
export function settleRunChanges(entry: PoolEntry, sessionId: string): void {
  const anchor = entry.transcript.findLast((t) => t.role === "assistant" && t.entryId)?.entryId;
  void finalizeRunChanges(entry, anchor, (a, files) => {
    entryBus(entry).send(JSON.stringify(stampEvent({ type: "event", sessionId, kind: "run_changes", entryId: a, files })));
  }).catch((err: unknown) => {
    safeStderr(`[run-changes] finalize failed: ${String(err)}\n`);
  });
}

// ---- Journal replay (revert/diff RPCs + translate-history) ----

export type RecordedChangeFile = RunChangeFile & { idx: number };
export type RecordedChange = { changeId: string; anchor?: string; files: RecordedChangeFile[] };

/** Rebuild all change records from the journal, applying revert markers in stream order. */
export function readRunChanges(entries: unknown[]): RecordedChange[] {
  const out: RecordedChange[] = [];
  for (const e of entries) {
    const rec = e as { type?: string; customType?: string; data?: unknown };
    if (rec?.type !== "custom") continue;
    const d = rec.data as { changeId?: unknown; anchor?: unknown; path?: unknown; files?: unknown } | undefined;
    if (rec.customType === RUN_CHANGES_CUSTOM_TYPE && typeof d?.changeId === "string" && Array.isArray(d.files)) {
      out.push({
        changeId: d.changeId,
        anchor: typeof d.anchor === "string" ? d.anchor : undefined,
        files: d.files.map((f: RunChangeFile, idx) => ({ ...f, idx })),
      });
    } else if (rec.customType === RUN_REVERT_CUSTOM_TYPE && typeof d?.changeId === "string" && typeof d.path === "string") {
      const target = out.find((c) => c.changeId === d.changeId)?.files.find((f) => f.path === d.path);
      if (target) target.reverted = true;
    }
  }
  return out;
}

function findRecord(records: RecordedChange[], anchor: string, filePath: string): { change: RecordedChange; file: RecordedChangeFile } {
  const change = records.find((c) => c.anchor === anchor);
  const file = change?.files.find((f) => f.path === filePath);
  if (!change || !file) throw new Error(hostI18n.t("errors.runChanges.notFound"));
  return { change, file };
}

async function readSnapshotFile(entry: PoolEntry, changeId: string, name: string): Promise<string> {
  try {
    return await fsp.readFile(path.join(snapshotDir(entry, changeId), name), "utf8");
  } catch {
    throw new Error(hostI18n.t("errors.runChanges.noSnapshot"));
  }
}

export async function runFileDiff(entry: PoolEntry, anchor: string, filePath: string): Promise<string> {
  const { change, file } = findRecord(readRunChanges(entry.manager?.getEntries() ?? []), anchor, filePath);
  if (file.noSnapshot) throw new Error(hostI18n.t("errors.runChanges.noSnapshot"));
  const before = file.created ? "" : await readSnapshotFile(entry, change.changeId, `${file.idx}.before`);
  const after = file.deleted ? "" : await readSnapshotFile(entry, change.changeId, `${file.idx}.after`);
  try {
    return editDiffString(before, after, file.path)?.diff ?? "";
  } catch {
    return "";
  }
}

/** Revert one run's change to one file; returns the change record's files for the run_changes
 *  re-push. Fails closed on any mismatch — never overwrites content it cannot account for. */
export async function revertRunFile(entry: PoolEntry, anchor: string, filePath: string): Promise<RunChangeFile[]> {
  const records = readRunChanges(entry.manager?.getEntries() ?? []);
  const { change, file } = findRecord(records, anchor, filePath);
  if (file.reverted) throw new Error(hostI18n.t("errors.runChanges.alreadyReverted"));
  if (file.noSnapshot) throw new Error(hostI18n.t("errors.runChanges.noSnapshot"));
  // Top-of-stack only: the latest non-reverted record for this path across every run
  let latest: RecordedChangeFile | undefined;
  for (const c of records) for (const f of c.files) if (f.path === filePath && !f.reverted) latest = f;
  if (latest !== file) throw new Error(hostI18n.t("errors.runChanges.notTop"));

  const current = await readSnapshot(filePath);
  if (file.deleted) {
    if (current !== null) throw new Error(hostI18n.t("errors.runChanges.modified"));
  } else {
    const after = await readSnapshotFile(entry, change.changeId, `${file.idx}.after`);
    if (current !== after) throw new Error(hostI18n.t("errors.runChanges.modified"));
  }
  if (file.created) {
    await fsp.unlink(filePath);
  } else {
    const before = await readSnapshotFile(entry, change.changeId, `${file.idx}.before`);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, before, "utf8");
  }
  entry.manager.appendCustomEntry(RUN_REVERT_CUSTOM_TYPE, { changeId: change.changeId, path: filePath });
  file.reverted = true;
  return change.files;
}
