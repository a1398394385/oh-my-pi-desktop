// Host pooled-session file polling (2s cadence), two duties per pass:
// 1. Fresh-session disk materialization: lazily persisted sessions (no file
//    until the first entry) get a session_list push the moment their file
//    exists, so the sidebar's pending row (copy-session-id disabled) clears
//    mid-run instead of at run end (PoolEntry.awaitDiskList).
// 2. External-write detection: the lock file carries no signal (.lock.os is an
//    advisory leftover, the publish hold window is <500ms); the only reliable
//    signal is the file being appended by a process other than ours: read the
//    new complete lines from pollKnownSize onward — an id not present in the
//    manager's in-memory index means an external write (CLI
//    conversation/rename/compact all persist new entries). Ids we wrote
//    ourselves always pass through memory first, so zero false positives.
// Pooled sessions = the full set desktop currently holds in memory (the host
// pool is unbounded; the frontend's OPEN_SESSIONS_MAX only governs UI LRU).
import { stat, open } from "node:fs/promises";
import { sessions } from "./state.ts";
import { handleListSessions } from "./rpc/session.ts";
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

const POLL_EXTERNAL_WRITES_MS = 2000;
async function pollExternalWrites() {
  for (const [sessionId, entry] of sessions.entries()) {
    try {
      const st = await stat(entry.path);
      if (st.size === entry.pollKnownSize) continue;
      // Fresh session's file first materialized on disk (lazy persistence; a
      // 0-byte window above keeps waiting)
      if (entry.awaitDiskList) {
        entry.awaitDiskList = false;
        // One list refresh is enough (the frame carries the full list); send it
        // to the first attached UI
        const ws = entry.uiSockets.values().next().value;
        if (ws) void handleListSessions(ws);
      }
      if (st.size < entry.pollKnownSize) entry.pollKnownSize = 0; // Full rewrite: rescan from the start
      const fh = await open(entry.path, "r");
      let data: Buffer;
      try {
        data = Buffer.alloc(st.size - entry.pollKnownSize);
        const { bytesRead } = await fh.read(data, 0, data.length, entry.pollKnownSize);
        data = data.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      // Consume up to the last complete line only (partial lines wait for the next poll, avoiding half-written JSON)
      let lineEnd = -1;
      for (let i = 0; i < data.length; i++) if (data[i] === 10) lineEnd = i;
      if (lineEnd < 0) continue;
      const newIds: string[] = [];
      let lineStart = 0;
      while (lineStart <= lineEnd) {
        const nl = data.indexOf(10, lineStart);
        const line = data.subarray(lineStart, nl).toString("utf8");
        lineStart = nl + 1;
        if (line.trim()) {
          try {
            const o = JSON.parse(line) as { id?: unknown; type?: unknown };
            // File bookkeeping rows are excluded from the check: the header
            // (type "session", its id has sessionId shape but getEntries
            // explicitly excludes headers) and the title slot row; only real
            // entries are compared against the in-memory index
            if (typeof o.id === "string" && o.type !== "session") newIds.push(o.id);
          } catch {
            // A complete but corrupted line: skip
          }
        }
      }
      entry.pollKnownSize += lineStart;
      if (entry.externalWrite || newIds.length === 0) continue;
      const known = new Set<string>(entry.manager.getEntries().map((e: { id?: string }) => e?.id));
      if (!newIds.some((id) => !known.has(id))) continue;
      entry.externalWrite = true;
      const frame = JSON.stringify({ type: "session_external_write", sessionId });
      for (const ws of entry.uiSockets) ws.send(frame);
    } catch (err) {
      // New session files are lazily persisted (created on the first entry): ENOENT = nothing to monitor yet, skip silently
      if ((err as { code?: string }).code === "ENOENT") continue;
      safeStderr(hostI18n.t("errors.host.extWritePollFailed", { path: entry.path, detail: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export function startSessionPoll(): void {
  setInterval(() => { void pollExternalWrites(); }, POLL_EXTERNAL_WRITES_MS);
}
