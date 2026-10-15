// Session activity time: the timestamp of the last `message` frame in the file.
//
// The SDK reports `SessionInfo.modified` as the file mtime, but mtime is not an
// activity clock: every attach/detach appends a `session_exit` diagnostic frame
// (SDK session-teardown) to the transcript, so merely opening an old session
// refreshes its mtime and the sidebar renders it as "just now". Reading the last
// message timestamp keeps list/branch times in step with what the transcript
// actually shows.
import { peekFileTail } from "@oh-my-pi/pi-utils/peek-file";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent";

/** Initial tail window; a `session_exit` run is a few hundred bytes. */
const ACTIVITY_TAIL_BYTES = 16 * 1024;
/** Upper bound for windows that start inside an oversized final frame. */
const ACTIVITY_TAIL_MAX_BYTES = 512 * 1024;
const ACTIVITY_CACHE_MAX = 4096;
/** Parallel tail reads; each opens its own file handle. */
const ACTIVITY_READ_CONCURRENCY = 8;

const activityCache = new Map<string, { size: number; mtimeMs: number; at: number }>();

/** Last `message` frame timestamp in a line-oriented tail slice; undefined when the window holds none. */
function lastMessageTimestamp(text: string): number | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; timestamp?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A truncated leading line or a partially flushed frame.
    }
    if (entry.type !== "message" || typeof entry.timestamp !== "string") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/**
 * Activity time for one session, falling back to mtime when the file carries no
 * message yet (fresh session) or cannot be read. Cached per file identity
 * (size + mtime) so repeated list refreshes skip the read.
 */
async function sessionActivityTime(info: SessionInfo): Promise<number> {
  const mtimeMs = info.modified.getTime();
  const cached = activityCache.get(info.path);
  if (cached && cached.size === info.size && cached.mtimeMs === mtimeMs) return cached.at;
  let at = mtimeMs;
  for (let window = ACTIVITY_TAIL_BYTES; ; window = Math.min(window * 4, ACTIVITY_TAIL_MAX_BYTES)) {
    try {
      const found = await peekFileTail(info.path, window, (tail) => lastMessageTimestamp(new TextDecoder().decode(tail)));
      if (found !== undefined) {
        at = found;
        break;
      }
    } catch {
      break; // Deleted or unreadable: keep mtime rather than dropping the row.
    }
    if (window >= info.size || window >= ACTIVITY_TAIL_MAX_BYTES) break;
  }
  if (activityCache.size >= ACTIVITY_CACHE_MAX) activityCache.clear();
  activityCache.set(info.path, { size: info.size, mtimeMs, at });
  return at;
}

/** Rewrite `modified` in place so downstream sorting and formatting read the activity time. */
export async function applyActivityTimes(list: SessionInfo[]): Promise<void> {
  for (let i = 0; i < list.length; i += ACTIVITY_READ_CONCURRENCY) {
    await Promise.all(
      list.slice(i, i + ACTIVITY_READ_CONCURRENCY).map(async (s) => {
        s.modified = new Date(await sessionActivityTime(s));
      }),
    );
  }
}
