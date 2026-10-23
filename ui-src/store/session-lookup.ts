// Session-store lookup helpers split from store/session.ts for its architecture
// line cap — pure logic, no store imports (queue-actions.ts is the precedent).
import type { OpenSession } from "../types/session";

// Reverse scan without the spread+reverse array copies (6a; hot on every delta frame).
// Overload keeps the call sites' type-guard lambdas narrowing like Array.find did.
export function findLast<T, R extends T>(items: readonly T[], pred: (it: T) => it is R): R | undefined;
export function findLast<T>(items: readonly T[], pred: (it: T) => boolean): T | undefined;
export function findLast<T>(items: readonly T[], pred: (it: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return items[i];
  return undefined;
}

// sessionId → path index over openSessions (keyed by path, looked up by sessionId on every
// frame). Rebuilt lazily when the Map reference changed — every membership write swaps the Map,
// so the index cannot go stale; in-place field mutations never change sessionId or path.
const sessionPathIndex = new Map<string, string>();
let sessionPathIndexFor: Map<string, OpenSession> | null = null;
export function pathOfSessionId(id: string, openSessions: Map<string, OpenSession>): string | undefined {
  if (sessionPathIndexFor !== openSessions) {
    sessionPathIndexFor = openSessions;
    sessionPathIndex.clear();
    for (const [p, s] of openSessions) sessionPathIndex.set(s.sessionId, p);
  }
  return sessionPathIndex.get(id);
}
