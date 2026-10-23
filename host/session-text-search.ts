// Sidebar full-text search: matches the user's prompts and the agent's replies across all session files under the current profile.
// Shares the retrieval tool's scan/search core (session-context.ts scanSessions + searchSessionContext):
// one parse path, one ranking. The former ripgrep-core prefilter (MAX_PARSED_FILES=80 with silent
// truncation of common-term candidates) was dropped for that full scan — measured 0.25s for the
// default profile's 169 sessions / 35979 entries (session-context.ts header) — and the sidebar
// already debounces input and shows a searching hint.
import { searchSessionContext, scanSessions, splitQueryTerms, type SessionContextHit, type SessionTurn } from "./session-context.ts";

export interface SessionTextHit {
  path: string;
  id: string;
  cwd: string;
  title: string | null;
  modified: string; // ISO
  /** Context fragment around the hit (whitespace-collapsed, ellipses on both ends as needed) */
  snippet: string;
}

const SNIPPET_LEAD = 70;
const SNIPPET_TAIL = 150;

function snippetAt(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_LEAD);
  const end = Math.min(text.length, index + SNIPPET_TAIL);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Snippet anchored at the earliest matched term in the turn's user text, falling back to the assistant text. */
function turnSnippet(turn: SessionTurn, terms: string[]): string {
  for (const text of [turn.user, turn.assistant]) {
    if (!text) continue;
    const hay = text.toLowerCase();
    let at = -1;
    for (const term of terms) {
      const i = hay.indexOf(term);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at >= 0) return snippetAt(text, at);
  }
  return "";
}

export async function searchSessionText(query: string, limit: number): Promise<SessionTextHit[]> {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return [];
  const sessions = await scanSessions();
  // Ranked turn hits shared with the retrieval tool; searchSessionContext already sorts
  // (score desc, turn ts desc), so the first hit seen per session is its best turn.
  const bestBySession = new Map<string, SessionContextHit>();
  for (const hit of searchSessionContext(sessions, query)) {
    const key = hit.session.info.path;
    if (!bestBySession.has(key)) bestBySession.set(key, hit);
  }
  return [...bestBySession.values()]
    .sort((a, b) => b.score - a.score || b.session.info.modified.getTime() - a.session.info.modified.getTime())
    .slice(0, limit)
    .map((hit) => ({
      path: hit.session.info.path,
      id: hit.session.info.id,
      cwd: hit.session.info.cwd,
      title: hit.session.info.title ?? null,
      modified: hit.session.info.modified.toISOString(),
      snippet: turnSnippet(hit.turn, terms),
    }));
}
