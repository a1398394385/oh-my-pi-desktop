// Session search shared by the global search palette (⌘⇧F) and the composer's
// @ session tab: one aggregation, one merge order, so the two surfaces can never
// disagree about which sessions exist or how title hits rank against content hits.
import { pathBase } from "../../store";
import type { DiskProject, DiskSessionRow } from "../../types/frames";
import type { SessionTextHit } from "../../store/projects";
import { sessionLabel } from "../main/sidebar/util";

export interface SessionMatch {
  path: string;
  title: string;
  repo: string;
  cwd: string;
  modified: string;
  /** Lowercased title + first message + repo, the title-hit haystack */
  searchText: string;
  archived?: boolean;
  /** Hit snippet for a full-text match (search_session_text); absent for title-only hits */
  snippet?: string;
}

/** Every disk session (projects + archive), named rows only — untitled/empty rows
 *  stay out exactly like the sidebar. `emptyLabel` is the caller's translated
 *  "empty session" copy (sessionLabel returns it for unnamed rows). */
export function collectSessionMatches(
  diskProjects: DiskProject[],
  archivedSessions: (DiskSessionRow & { cwd: string })[],
  emptyLabel: string,
): SessionMatch[] {
  const list: SessionMatch[] = [];
  const seenPaths = new Set<string>();
  const push = (s: DiskSessionRow, cwd: string, archived: boolean) => {
    if (seenPaths.has(s.path)) return;
    const displayTitle = sessionLabel(s);
    if (!displayTitle || displayTitle === emptyLabel) return;
    seenPaths.add(s.path);
    const repo = pathBase(cwd);
    list.push({
      path: s.path,
      title: displayTitle,
      searchText: `${s.title || ""} ${s.firstMessage || ""} ${repo}`.toLowerCase(),
      repo,
      cwd,
      modified: s.modified,
      archived,
    });
  };
  for (const p of diskProjects) for (const s of p.sessions) push(s, p.cwd, false);
  for (const s of archivedSessions) push(s, s.cwd, true);
  return list;
}

/** Merge title matches with full-text hits (session_text_search): content hits fill in first so a row hit by both keeps its snippet, sidebar rows fill in the rest. */
export function mergeSearchMatches(
  allSessions: SessionMatch[],
  textHits: SessionTextHit[],
  kw: string,
  untitled: string,
): SessionMatch[] {
  if (!kw) return [];
  const known = new Map(allSessions.map((s) => [s.path, s]));
  const byPath = new Map<string, SessionMatch>();
  for (const hit of textHits) {
    const row = known.get(hit.path);
    byPath.set(hit.path, {
      path: hit.path,
      // Content hits may be sessions no project row carries (removed projects, unlisted history) — keep them reachable anyway
      title: row?.title || hit.title || untitled,
      repo: row?.repo || pathBase(hit.cwd),
      cwd: hit.cwd,
      modified: hit.modified,
      searchText: "",
      archived: row?.archived,
      snippet: hit.snippet,
    });
  }
  for (const s of allSessions) {
    if (!s.searchText.includes(kw)) continue;
    const prev = byPath.get(s.path);
    byPath.set(s.path, prev ? { ...prev, title: s.title, repo: s.repo, modified: s.modified, archived: s.archived } : s);
  }
  return [...byPath.values()].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)).slice(0, 20);
}
