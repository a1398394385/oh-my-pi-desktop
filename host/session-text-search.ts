// Sidebar full-text search: matches the user's prompts and the agent's replies across all session files under the current profile.
// Why the base's native grep and not listAllSessions' allMessagesText: that field is only spliced together from the 4 KB header prefix (session-listing.ts SESSION_LIST_PREFIX_BYTES), it is not the whole transcript, and a full JSONL reparse costs seconds on hundreds of MB.
// pi-natives grep (the base's ripgrep-core native search) sweeps the raw text at memory speed (~70ms on 700MB / 533 sessions), so only the hit files get parsed to locate the turn and cut the snippet.
import path from "node:path";
import { FileSessionStorage, getSessionsDir, grep, GrepOutputMode, listAllSessions, loadEntriesFromFile } from "./bootstrap.ts";
import { splitQueryTerms, turnsFromEntries } from "./session-context.ts";

export interface SessionTextHit {
  path: string;
  id: string;
  cwd: string;
  title: string | null;
  modified: string; // ISO
  /** Context fragment around the hit (whitespace-collapsed, ellipses on both ends as needed) */
  snippet: string;
}

// Cap the files actually parsed after the grep prefilter: a common term can hit hundreds of files, and parsing is orders of magnitude slower
const MAX_PARSED_FILES = 80;
const SNIPPET_LEAD = 70;
const SNIPPET_TAIL = 150;

function snippetAt(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_LEAD);
  const end = Math.min(text.length, index + SNIPPET_TAIL);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Session files containing any term (OR recall, regex-escaped); the AND check happens in JS because grep has no AND across alternatives */
export async function candidateFiles(sessionsRoot: string, terms: string[]): Promise<string[]> {
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const result = await grep({
    pattern,
    path: sessionsRoot,
    // Only main session files, the same set as listAllSessions (*/*.jsonl): subagent files in deeper directories are not sidebar sessions
    glob: "*/*.jsonl",
    recursive: true,
    ignoreCase: true,
    mode: GrepOutputMode.FilesWithMatches,
    maxCount: MAX_PARSED_FILES,
  });
  return result.matches.map((m) => path.join(sessionsRoot, m.path));
}

export async function searchSessionText(query: string, limit: number): Promise<SessionTextHit[]> {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return [];
  const sessionsRoot = getSessionsDir();
  const candidates = await candidateFiles(sessionsRoot, terms);
  if (candidates.length === 0) return [];
  const candidateSet = new Set(candidates);

  // Metadata (id/cwd/title/modified) for candidate sessions only: the full scan stays on the rg side
  const byPath = new Map(
    (await listAllSessions(new FileSessionStorage()))
      .filter((info) => candidateSet.has(info.path))
      .map((info) => [info.path, info]),
  );

  const hits: (SessionTextHit & { score: number; ts: number })[] = [];
  const storage = new FileSessionStorage();
  for (const file of candidates) {
    const info = byPath.get(file);
    if (!info) continue;
    let best: { score: number; at: number; text: string } | null = null;
    for (const turn of turnsFromEntries(await loadEntriesFromFile(file, storage))) {
      for (const text of [turn.user, turn.assistant]) {
        if (!text) continue;
        const hay = text.toLowerCase();
        let score = 0;
        let at = -1;
        for (const term of terms) {
          const i = hay.indexOf(term);
          if (i < 0) {
            score = 0;
            break;
          }
          score++;
          if (at < 0 || i < at) at = i;
        }
        if (score === 0 || at < 0) continue;
        if (!best || score > best.score || (score === best.score && text.length < best.text.length)) {
          best = { score, at, text };
        }
      }
    }
    if (!best) continue;
    hits.push({
      path: file,
      id: info.id,
      cwd: info.cwd,
      title: info.title ?? null,
      modified: info.modified.toISOString(),
      snippet: snippetAt(best.text, best.at),
      score: best.score,
      ts: info.modified.getTime(),
    });
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, limit);
}
