// Run file-change RPC: per-file revert (write, remote-denylisted) and snapshot diff (read).
// Both replay the session journal via run-changes.ts — no in-memory state is consulted, so a
// reloaded session behaves exactly like a live one. Failures throw → the shell's error frame.
import { sessions, entryBus, stampEvent } from "../state.ts";
import { revertRunFile, runFileDiff } from "../run-changes.ts";
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";
import type { PoolEntry } from "../state.ts";

function loadedEntry(msg: { sessionId?: unknown }): PoolEntry {
  const entry = sessions.get(String(msg.sessionId ?? ""));
  if (!entry) throw new Error(hostI18n.t("errors.runChanges.sessionNotLoaded"));
  return entry;
}

export const runChangesHandlers: Record<string, RpcHandler> = {
  async revert_run_file(ws, msg) {
    const entry = loadedEntry(msg);
    const anchor = String(msg.entryId ?? "");
    const files = await revertRunFile(entry, anchor, String(msg.path ?? ""));
    // Every attached UI updates the card (and the other runs' revert buttons recompute from it)
    entryBus(entry).send(
      JSON.stringify(
        stampEvent({
          type: "event",
          sessionId: String(msg.sessionId ?? ""),
          kind: "run_changes",
          entryId: anchor,
          files: files.map(({ idx: _idx, ...f }) => f),
        }),
      ),
    );
  },
  async get_run_file_diff(ws, msg) {
    const entry = loadedEntry(msg);
    const diff = await runFileDiff(entry, String(msg.entryId ?? ""), String(msg.path ?? ""));
    // fan-out: requester-only — the right-panel diff view is per-requester state (file_diff parity)
    ws.send(
      JSON.stringify({
        type: "run_file_diff",
        sessionId: String(msg.sessionId ?? ""),
        entryId: String(msg.entryId ?? ""),
        path: String(msg.path ?? ""),
        diff,
      }),
    );
  },
};
