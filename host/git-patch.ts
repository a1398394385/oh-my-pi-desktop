// Line-level staging: cut a file's patch down to some of its changed lines so
// `git apply` stages, unstages or discards exactly those (IntelliJ's and
// `git gui`'s "stage selected lines").
//
// Ported from MyGit's internal/patch. A patch is parsed into hunks whose lines
// keep their diff prefix; selecting lines rewrites each hunk header and drops
// or demotes the unselected changes:
//
//   forward  (stage)   unselected `-` becomes context, unselected `+` goes
//   reverse  (unstage, discard) the other way around
//
// Everything here is pure: the only IO entry point takes the caller's git
// runner, so tests can feed it canned results.
import type { GitResult } from "./git.ts";
import { gitError } from "./git.ts";

/** A patch above this size is not worth cutting; git apply would crawl. */
export const MAX_PATCH_BYTES = 400_000;

export type LineMode = "stage" | "unstage" | "discard";

/** The two locking classes of host/git.ts, injected so this module stays IO-free. */
export interface GitRunner {
  read(args: string[], input?: string): Promise<GitResult>;
  write(args: string[], input?: string): Promise<GitResult>;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  /** Raw diff lines, prefix included. */
  lines: string[];
}

interface ParsedPatch {
  oldName: string;
  newName: string;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse the single-file patch git diff prints for one path. */
function parsePatch(patch: string): ParsedPatch {
  const out: ParsedPatch = { oldName: "", newName: "", binary: false, hunks: [] };
  let hunk: Hunk | null = null;
  for (const line of patch.split("\n")) {
    if (line === "") continue;
    // Inside a hunk only a new hunk header or a new file section ends it: a
    // content line may itself read "+++ x" or "--- x".
    if (hunk && !line.startsWith("@@") && !line.startsWith("diff --git ")) {
      hunk.lines.push(line);
      continue;
    }
    hunk = null;
    const head = HUNK_HEADER.exec(line);
    if (head) {
      hunk = { oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] };
      out.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const name = line.slice(4);
      const bare = name === "/dev/null" ? "" : name.replace(/^[ab]\//, "");
      if (line.startsWith("--- ")) out.oldName = bare;
      else out.newName = bare;
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      out.binary = true;
      continue;
    }
    // Everything else before the first hunk is metadata: diff --git, index,
    // mode, similarity, rename/copy. It carries nothing selectLines needs.
  }
  return out;
}

/** True when the patch's lines can be split: an in-place text edit. */
export function partial(patch: string): boolean {
  const p = parsePatch(patch);
  return !p.binary && p.oldName !== "" && p.oldName === p.newName && p.hunks.length > 0;
}

/** The three-line preamble every cut patch needs. */
export function fileHeader(patch: string): string {
  const name = parsePatch(patch).newName;
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
}

/** A hunk's first line, 0 for a side with no lines, as diff writes it. */
function start(at: number, n: number): number {
  return n === 0 && at > 0 ? at - 1 : at;
}

/**
 * A patch holding only the changes on the given new-side lines (1-based).
 * `reverse` cuts it for `git apply --reverse`, which works on the new side:
 * unselected additions stay, unselected deletions go.
 * Null when nothing of the requested lines is a real change.
 */
export function selectLines(patch: string, lines: ReadonlySet<number>, reverse: boolean): string | null {
  const p = parsePatch(patch);
  // Not cuttable at all: added, deleted, renamed or binary.
  if (p.binary || p.oldName === "" || p.oldName !== p.newName || p.hunks.length === 0) return null;
  // New-side number → change block → "hunk:index". A block is the run of -/+
  // lines one edit replaced; choosing any of its lines chooses all of them,
  // since staging half a replaced line would duplicate it in the index.
  const chosen = new Set<string>();
  p.hunks.forEach((hunk, h) => {
    const blocks: Array<{ at: number[]; newLines: number[] }> = [];
    let cur: { at: number[]; newLines: number[] } | null = null;
    let newNo = hunk.newStart;
    hunk.lines.forEach((line, i) => {
      const kind = line[0];
      if (kind === "-" || kind === "+") {
        if (!cur) {
          cur = { at: [], newLines: [] };
          blocks.push(cur);
        }
        cur.at.push(i);
        if (kind === "+") cur.newLines.push(newNo++);
        return;
      }
      cur = null;
      if (kind !== "\\") newNo++;
    });
    for (const b of blocks) {
      // A pure deletion owns no new-side line, so it can only ride along.
      if (b.newLines.some((n) => lines.has(n))) for (const i of b.at) chosen.add(`${h}:${i}`);
    }
  });

  const body: string[] = [];
  let any = false;
  p.hunks.forEach((hunk, h) => {
    const kept: string[] = [];
    let oldN = 0;
    let newN = 0;
    let changed = false;
    hunk.lines.forEach((line, i) => {
      const kind = line[0];
      if (kind === "\\") {
        // "No newline at end of file" goes with the line before it, if that stayed.
        if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push(line);
        return;
      }
      let out = line;
      let outKind = kind;
      if (kind === "+" || kind === "-") {
        if (!chosen.has(`${h}:${i}`)) {
          const keep = reverse ? "+" : "-";
          if (kind !== keep) {
            kept.push(""); // dropped: a "\" after it goes too
            return;
          }
          outKind = " ";
          out = ` ${line.slice(1)}`;
        }
      }
      if (outKind === "+" || outKind === "-") changed = true;
      if (outKind !== "+") oldN++;
      if (outKind !== "-") newN++;
      kept.push(out);
    });
    if (!changed) return;
    any = true;
    const oldStart = reverse ? hunk.newStart : hunk.oldStart;
    body.push(`@@ -${start(oldStart, oldN)},${oldN} +${start(oldStart, newN)},${newN} @@`);
    for (const l of kept) if (l !== "") body.push(l);
  });
  if (!any) return null;
  return fileHeader(patch) + body.map((l) => `${l}\n`).join("");
}

/**
 * Stage/unstage/discard the given new-side lines of one file.
 * Returns null on success, or the reason to show the user.
 */
export async function applyLines(
  run: GitRunner,
  cwd: string,
  filePath: string,
  lines: readonly number[],
  mode: LineMode,
): Promise<string | null> {
  // Unstage reads the index against HEAD; the other two read the work tree.
  const diffArgs = mode === "unstage" ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
  const read = await run.read(diffArgs);
  if (!read.ok) return gitError(read) || `git diff failed for ${filePath}`;
  const patch = read.stdout;
  if (!patch.trim()) return `no ${mode === "unstage" ? "staged " : ""}changes in ${filePath}`;
  if (patch.length > MAX_PATCH_BYTES) return `diff for ${filePath} is too large for line ${mode}`;
  if (!partial(patch)) {
    return `${filePath} changed shape (added, deleted, renamed or binary); line ${mode} not possible`;
  }
  const cut = selectLines(patch, new Set(lines), mode !== "stage");
  if (!cut) return `no change on the selected lines of ${filePath}`;
  const args = mode === "stage"
    ? ["apply", "--cached", "-"]
    : mode === "unstage"
      ? ["apply", "--cached", "--reverse", "-"]
      : ["apply", "--reverse", "-"];
  const applied = await run.write(args, cut);
  // git apply's own stderr explains a rejected hunk; never swallow it.
  return applied.ok ? null : gitError(applied) || `git apply failed for ${filePath}`;
}
