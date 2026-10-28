// "Viewed" marks of the Git diff file list. A mark is the file's content
// fingerprint, not its path, so an edited file reads as unread again. One
// localStorage bucket per cwd (prefix omp.gitViewed.) keeps the keys joined as
// `${cwd}\0${path}\0${fingerprint}`, insertion-ordered and capped: the oldest
// marks fall off first.
const PREFIX = "omp.gitViewed.";
const CAP = 2000;

const subs = new Set<() => void>();
const cache = new Map<string, ReadonlySet<string>>(); // cwd -> keys; a new reference per write

function load(cwd: string): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + cwd) ?? "[]") as unknown;
    if (Array.isArray(raw)) return new Set(raw.filter((k): k is string => typeof k === "string").slice(-CAP));
  } catch {
    // corrupt or unavailable storage: start empty instead of breaking the list
  }
  return new Set();
}

export function viewedKey(cwd: string, path: string, fingerprint: string): string {
  return `${cwd}\u0000${path}\u0000${fingerprint}`;
}

/** Current marks of one cwd (stable reference until the next write). */
export function viewedSnapshot(cwd: string): ReadonlySet<string> {
  let keys = cache.get(cwd);
  if (!keys) cache.set(cwd, (keys = load(cwd)));
  return keys;
}

export function subscribeViewed(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function toggleViewed(cwd: string, path: string, fingerprint: string): void {
  const key = viewedKey(cwd, path, fingerprint);
  const keys = [...viewedSnapshot(cwd)];
  const at = keys.indexOf(key);
  if (at >= 0) keys.splice(at, 1);
  else keys.push(key);
  const next = keys.slice(-CAP);
  cache.set(cwd, new Set(next));
  try {
    localStorage.setItem(PREFIX + cwd, JSON.stringify(next));
  } catch {
    // storage full or blocked: the in-memory mark still holds for this session
  }
  for (const fn of subs) fn();
}
