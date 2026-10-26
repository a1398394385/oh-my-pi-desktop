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
import { refreshAllSessionLists } from "./rpc/session.ts";
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

const POLL_EXTERNAL_WRITES_MS = 2000;
async function pollExternalWrites() {
  for (const [sessionId, entry] of sessions.entries()) {
    // Subagent transcripts (child jsonl in the parent's artifacts dir) are appended by
    // THIS host's own task runtime while the user watches the page — the in-memory index
    // cannot tell that apart from an external CLI, so every live subagent view would show
    // the "another process is writing" bar (BUG-045 class: a second manager over one file).
    if (entry.isSubagent) continue;
    try {
      const st = await stat(entry.path);
      if (st.size === entry.pollKnownSize) continue;
      // Fresh session's file first materialized on disk (lazy persistence; a
      // 0-byte window above keeps waiting)
      if (entry.awaitDiskList) {
        entry.awaitDiskList = false;
        // One list refresh is enough (the frame carries the full list); every
        // connected UI gets it, so the channel that didn't create the session
        // drops its pending row at the same moment.
        await refreshAllSessionLists();
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
      const rows: { id: string; kind: string }[] = [];
      let lineStart = 0;
      while (lineStart <= lineEnd) {
        const nl = data.indexOf(10, lineStart);
        const line = data.subarray(lineStart, nl).toString("utf8");
        lineStart = nl + 1;
        if (line.trim()) {
          try {
            const o = JSON.parse(line) as { id?: unknown; type?: unknown; customType?: unknown };
            // File bookkeeping rows are excluded from the check: the header
            // (type "session", its id has sessionId shape but getEntries
            // explicitly excludes headers) and the title slot row; only real
            // entries are compared against the in-memory index
            if (typeof o.id === "string" && o.type !== "session") {
              const kind = typeof o.customType === "string" ? `custom:${o.customType}` : String(o.type ?? "?");
              rows.push({ id: o.id, kind });
            }
          } catch {
            // A complete but corrupted line: skip
          }
        }
      }
      entry.pollKnownSize += lineStart;
      // Evicted mid-iteration (archive / delete / LRU teardown): the manager is
      // being released, so its index no longer describes this file and every row
      // below would look foreign.
      if (sessions.get(sessionId) !== entry) continue;
      const known = new Set<string>(entry.manager.getEntries().map((e: { id?: string }) => e?.id));
      if (known.size === 0) continue; // released manager: an empty index proves nothing about the file
      if (rows.length === 0) continue;
      const foreign = rows.filter((r) => !known.has(r.id));
      if (foreign.length === 0) {
        // Every new id is already in the in-memory index: either our own writes,
        // or a rewrite whose stale offset produced a line that merely looked
        // foreign. Clear a bar that was raised earlier instead of leaving it up
        // until the next reload.
        if (entry.externalWrite) {
          entry.externalWrite = false;
          const clear = JSON.stringify({ type: "session_external_write", sessionId, clear: true });
          for (const ws of entry.uiSockets) ws.send(clear);
        }
        continue;
      }
      if (entry.externalWrite) continue;
      // Visit trail for the "another process is writing" bar: which ids and entry
      // kinds were not in this manager, so a false positive is diagnosable without
      // re-running the session.
      safeStderr(`[extwrite] ${sessionId} foreign=${JSON.stringify(foreign)} known=${known.size} path=${entry.path}`);
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
