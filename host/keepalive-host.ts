// Host-side keepalive state machine (A16): the keepaliveWanted intent flips
// and the keepalive_status frame body live here instead of being handwritten
// at four call sites. The runtime probe chain itself is the injected
// extension in keepalive.ts; the state fields stay on PoolEntry (state.ts) —
// this module converges the operations, the frame-body semantics, and the
// reportState push, so the wire semantics are not spread across comments.
import { sessions, stampEvent, type PoolEntry } from "./state.ts";
import { readKeepaliveEnabled, readKeepaliveProbeConfig } from "./keepalive-config.ts";
import type { KeepaliveState } from "./keepalive.ts";

/**
 * Turn wrap-up (the terminal agent_end in session-lifecycle's event
 * subscription): the turn produced unread output, so the session is worth
 * keeping alive while idle from now on. Cleared again by markSeen — only
 * sessions the user has not seen yet are probed.
 */
export function markTurnWrapped(entry: PoolEntry): void {
  entry.keepaliveWanted = true;
}

/**
 * User interaction with the session (create/load/send/mark_seen): the user
 * has seen it, so stop cache keepalive probing. The next turn's wrap-up
 * (markTurnWrapped) sets the intent again.
 */
export function markSeen(entry: PoolEntry): void {
  entry.keepaliveWanted = false;
}

/** keepalive_status frame body (shared by the RPC reply and the reportState push).
 * Effective keepalive includes the target check: a session whose current model is not a
 * configured keepalive target is never probed, so both paths must report the zeroed
 * disabled shape for it — otherwise a model removed from targets mid-run would keep the
 * context card's cache-warming section alive via reportState pushes. */
export function keepaliveStatusPayload(sessionId: string, state: KeepaliveState | undefined) {
  const entry = sessions.get(sessionId);
  const model = entry?.session.model as { provider?: string; id?: string } | undefined | null;
  const targeted =
    typeof model?.provider === "string" &&
    typeof model?.id === "string" &&
    readKeepaliveProbeConfig().targets.includes(`${model.provider}/${model.id}`);
  const eff = targeted ? state : undefined;
  return {
    type: "keepalive_status" as const,
    sessionId,
    enabled: eff !== undefined && readKeepaliveEnabled(),
    active: eff?.active ?? false,
    probes: eff?.probes ?? 0,
    hits: eff?.hits ?? 0,
    misses: eff?.misses ?? 0,
    errors: eff?.errors ?? 0,
    savedUsd: eff?.savedUsd ?? 0,
    spendUsd: eff?.spendUsd ?? 0,
    nextProbeAt: eff?.nextProbeAt ?? null,
  };
}

/**
 * reportState sink for the injected extension (keepalive.ts KeepaliveHostOptions):
 * store the fresh snapshot on the pool entry and push the keepalive_status frame
 * so the context ring's center counter and the detail card stay live without
 * polling (report cadence is per-probe/per-schedule, low frequency).
 */
export function reportKeepaliveState(entry: PoolEntry, s: KeepaliveState): void {
  entry.keepaliveState = s;
  if (!entry.keepaliveSid) return;
  const data = JSON.stringify(stampEvent(keepaliveStatusPayload(entry.keepaliveSid, s)));
  for (const ws of entry.uiSockets) {
    // readyState only exists on real sockets; adapters (entryBus) omit it — treat as open
    if ("readyState" in ws ? ws.readyState === 1 : true) ws.send(data);
  }
}
