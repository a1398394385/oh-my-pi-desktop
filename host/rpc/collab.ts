// Collab live-sharing domain RPCs: collab_start (host a room on a relay),
// collab_join (join via link), collab_leave, collab_state (read/push current
// role+participants). Adapts the base SDK collab transports (CollabHost /
// CollabGuestLink) to the desktop session pool: one runtime per pooled session
// in #collabRuntimes, each wrapping the session in an InteractiveModeContext
// stub — the seam the TUI normally fills (same approach as the fork's
// RpcCollabController, hardened with the seams 18.11.3's guest path touches).
// Frame contract: every op replies with a collab_state frame (state + optional
// error) so the dialog lands one shape for success and failure; participant
// changes arrive as the same frame via the statusLine.setCollabStatus seam.
// Errors deliberately do NOT throw for expected failures (wrong role, bad
// link, relay unreachable): the dispatch shell would turn them into generic
// error frames, losing the in-dialog display. Unexpected exceptions still hit
// the shell.
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { cfgCollabRelayUrl, cfgCollabWebUrl } from "@oh-my-pi/pi-coding-agent/collab/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { entryBus, sessions, stampEvent, type PoolEntry } from "../state.ts";
import { hostI18n } from "../i18n/host.ts";
import { safeStderr } from "../stderr.ts";
import type { CollabRpcState } from "../wire/frames-live.ts";
import type { RpcHandler } from "./types";

interface CollabRuntime {
  entry: PoolEntry;
  ctx: InteractiveModeContext;
  host?: CollabHost;
  guest?: CollabGuestLink;
}

// Session-scoped collab runtimes, keyed by pool sessionId. Lives here (not
// state.ts) because only this domain touches it; lazy cleanup on every op
// covers pool eviction without a teardown hook in the lifecycle code.
const collabRuntimes = new Map<string, CollabRuntime>();

const NO_COLLAB: CollabRpcState = { role: null, readOnly: false, participants: [] };

function normalizeRelayUrl(value: string): string {
  return value.includes("://") ? value : `wss://${value}`;
}

/** The runtime for sessionId, or undefined when none / session left the pool (evicted → disposed lazily). */
function liveRuntime(sessionId: string): CollabRuntime | undefined {
  const rt = collabRuntimes.get(sessionId);
  if (!rt) return undefined;
  if (sessions.get(sessionId) !== rt.entry) {
    void disposeRuntime(rt, "session left the pool");
    collabRuntimes.delete(sessionId);
    return undefined;
  }
  return rt;
}

function stateOf(rt: CollabRuntime | undefined): CollabRpcState {
  if (!rt) return NO_COLLAB;
  if (rt.host) {
    return {
      role: "host",
      readOnly: false,
      link: rt.host.link,
      viewLink: rt.host.viewLink,
      webLink: rt.host.webLink,
      webViewLink: rt.host.webViewLink,
      participants: rt.host.participants,
    };
  }
  if (rt.guest && rt.ctx.collabGuest === rt.guest) {
    return { role: "guest", readOnly: rt.guest.readOnly, participants: rt.guest.state?.participants ?? [] };
  }
  return NO_COLLAB;
}

// Build the frame once, reply to the requester, fan out to every UI watching
// the session (guest/host state must stay consistent across windows + remote).
// The fan-out goes through the pool entry so watchers stay current even with
// no live runtime (role-null replies after leave/failed start).
function pushCollabState(sessionId: string, rt: CollabRuntime | undefined, to?: { send(data: string): unknown }, error?: string) {
  const frame = stampEvent({ type: "collab_state", sessionId, state: stateOf(rt), ...(error ? { error } : {}) });
  const data = JSON.stringify(frame);
  if (to) to.send(data);
  const sockets = rt?.entry.uiSockets ?? sessions.get(sessionId)?.uiSockets;
  if (sockets) {
    for (const w of sockets) {
      if (w !== to) w.send(data);
    }
  }
}

/** The InteractiveModeContext seam the collab transports talk through. Desktop equivalents: status → state pushes, events → UI fan-out. */
function buildContext(entry: PoolEntry, sessionId: string): InteractiveModeContext {
  const session = entry.session;
  const clearable = { clear: () => {}, disposeChildren: () => {} };
  return {
    session,
    sessionManager: session.sessionManager,
    settings: session.settings,
    eventBus: undefined,
    subagentEventBus: undefined,
    collabHost: undefined,
    collabGuest: undefined,
    statusLine: {
      // Participant join/leave + relay drops surface through this seam in the
      // TUI; here it is the live collab_state push (the "base event" the UI
      // subscribes to instead of polling).
      setCollabStatus: () => pushCollabState(sessionId, collabRuntimes.get(sessionId)),
      getCachedContextBreakdown: () => session.getContextBreakdown() ?? {},
      invalidate: () => {},
      resetActiveTime: () => {},
      markActivityStart: () => {},
      markActivityEnd: () => {},
    },
    ui: { requestRender: () => {}, requestComponentRender: () => {}, setFocus: () => {} },
    chatContainer: clearable,
    pendingMessagesContainer: clearable,
    statusContainer: clearable,
    pendingTools: new Map(),
    compactionQueuedMessages: [],
    streamingComponent: undefined,
    streamingMessage: undefined,
    loadingAnimation: undefined,
    autoCompactionLoader: undefined,
    retryLoader: undefined,
    eventController: {
      // Mirrored guest events re-enter the pool entry's normal fan-out so the
      // desktop transcript keeps behaving like a local stream.
      handleEvent: async () => {},
      dispatchSessionEvent: async (event: unknown) => {
        entryBus(entry).send(JSON.stringify(stampEvent({ type: "event", sessionId, ...(event as object) })));
      },
      takeDisplaceableComponents: () => [],
      resetTranscriptAnchors: () => {},
    },
    showStatus: (message: string) => safeStderr(`[collab] ${sessionId.slice(0, 8)} ${message}\n`),
    showError: (message: string) => safeStderr(`[collab] ${sessionId.slice(0, 8)} ${message}\n`),
    // Extension UI mirroring (dialogs raised host-side shown to guests) has no
    // desktop surface yet; unanswered requests time out host-side.
    showHookSelector: () => Promise.resolve(undefined),
    showHookEditor: () => Promise.resolve(undefined),
    ensureLoadingAnimation: () => {},
    updatePendingMessagesDisplay: () => {},
    syncRunningSubagentBadge: () => {},
    resetObserverRegistry: () => {},
    updateEditorBorderColor: () => {},
    renderInitialMessages: () => pushCollabState(sessionId, collabRuntimes.get(sessionId)),
    reloadTodos: async () => {},
    handleResumeSession: async (sessionFile: string) => {
      // Guest replica activation: the SDK switches this pooled session onto
      // the replica file; the core session subscription keeps firing, the UI
      // refetches messages off the collab_state role change.
      await session.switchSession(sessionFile);
      pushCollabState(sessionId, collabRuntimes.get(sessionId));
    },
  } as unknown as InteractiveModeContext;
}

function ensureRuntime(sessionId: string): CollabRuntime {
  const existing = liveRuntime(sessionId);
  if (existing) return existing;
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.collab.sessionNotFound", { sessionId }));
  const rt: CollabRuntime = { entry, ctx: buildContext(entry, sessionId) };
  collabRuntimes.set(sessionId, rt);
  return rt;
}

/** Lazy-eviction teardown: null the pointers first (re-entrant pushes see role null), then drain the transports. */
async function disposeRuntime(rt: CollabRuntime, reason: string): Promise<void> {
  const { guest, host } = rt;
  rt.guest = undefined;
  rt.host = undefined;
  rt.ctx.collabGuest = undefined;
  rt.ctx.collabHost = undefined;
  try {
    // guest.leave also restores the pre-join session file (SDK-side)
    if (guest) await guest.leave(reason);
  } catch (err) {
    safeStderr(`[collab] guest teardown failed: ${String(err)}\n`);
  }
  try {
    if (host) await host.stop(reason);
  } catch (err) {
    safeStderr(`[collab] host teardown failed: ${String(err)}\n`);
  }
}

export const collabHandlers: Record<string, RpcHandler> = {
  // Host a room for the session. relayUrl empty → profile setting collab.relayUrl
  // → base default (wss://my.omp.sh). Hosting while a turn runs is allowed on
  // purpose (fork semantics): the room mirrors the live session, guests get the
  // in-flight turn via snapshot + events. Failed start leaves no runtime behind.
  async collab_start(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    try {
      const rt = ensureRuntime(sessionId);
      if (rt.guest) throw new Error(hostI18n.t("errors.collab.guestActive"));
      if (rt.host) {
        pushCollabState(sessionId, rt, ws);
        return;
      }
      const relay = String(msg.relayUrl ?? "").trim() || cfgCollabRelayUrl.get(rt.entry.session.settings) || "";
      if (!relay) throw new Error(hostI18n.t("errors.collab.noRelay"));
      const host = new CollabHost(rt.ctx, {
        // Relay ended the room for good (non-retryable close / fatal socket
        // failure): teardown already began SDK-side; drop the runtime and
        // tell the UI the room is gone.
        onEnded: () => {
          if (collabRuntimes.get(sessionId)?.host === host) {
            rt.host = undefined;
            rt.ctx.collabHost = undefined;
            collabRuntimes.delete(sessionId);
            pushCollabState(sessionId, undefined);
          }
        },
      });
      await host.start(normalizeRelayUrl(relay), cfgCollabWebUrl.get(rt.entry.session.settings) || "");
      rt.host = host;
      rt.ctx.collabHost = host;
      pushCollabState(sessionId, rt, ws);
    } catch (err) {
      // Failed start leaves no stub runtime behind.
      const cur = collabRuntimes.get(sessionId);
      if (cur && !cur.host && !cur.guest) collabRuntimes.delete(sessionId);
      pushCollabState(sessionId, liveRuntime(sessionId), ws, err instanceof Error ? err.message : String(err));
    }
  },

  // Join a room via link. The SDK claims the process (ctx.collabGuest) and
  // switches the session onto its replica; joining while a local turn runs is
  // the SDK's session-transition concern (same as the fork, no busy gate here).
  async collab_join(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    try {
      const rt = ensureRuntime(sessionId);
      if (rt.host) throw new Error(hostI18n.t("errors.collab.hostActive"));
      if (rt.guest) {
        pushCollabState(sessionId, rt, ws);
        return;
      }
      const link = String(msg.link ?? "").trim();
      if (!link) throw new Error(hostI18n.t("errors.collab.linkRequired"));
      const guest = new CollabGuestLink(rt.ctx);
      await guest.join(link);
      rt.guest = guest;
      pushCollabState(sessionId, rt, ws);
    } catch (err) {
      // Failed join: the SDK restores the local session itself; drop the stub
      // runtime (a half-claimed ctx.collabGuest recovers via collab_leave).
      const cur = collabRuntimes.get(sessionId);
      if (cur && !cur.host && !cur.guest) collabRuntimes.delete(sessionId);
      pushCollabState(sessionId, liveRuntime(sessionId), ws, err instanceof Error ? err.message : String(err));
    }
  },

  async collab_leave(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const rt = liveRuntime(sessionId);
    if (rt) {
      // Null-and-drain teardown (guest leave restores the local session; host
      // stop says goodbye and withdraws from the registry).
      await disposeRuntime(rt, "left");
      collabRuntimes.delete(sessionId);
    }
    pushCollabState(sessionId, undefined, ws);
  },

  // Pure read (dialog open / refresh); also the reply channel for role null.
  collab_state(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const rt = liveRuntime(sessionId);
    pushCollabState(sessionId, rt, ws);
  },
};

// ---------- guest prompt/abort relay hooks (wired from prompt.ts / session.ts) ----------

/**
 * Route a user prompt through the collab wire when this session is a joined
 * guest: guest replicas must not be prompted locally (the host machine owns
 * the real run). Returns true when the prompt was consumed (relayed, or
 * refused for a read-only link — the refusal is replied as an error frame).
 * False = not a guest, normal local flow continues.
 */
export function relayGuestPrompt(sessionId: string, text: string, images?: ImageContent[], ws?: { send(data: string): unknown }): boolean {
  const rt = liveRuntime(sessionId);
  const guest = rt?.guest;
  if (!guest || rt!.ctx.collabGuest !== guest) return false;
  if (guest.readOnly) {
    ws?.send(JSON.stringify({ type: "error", sessionId, message: hostI18n.t("errors.collab.readOnly") }));
    return true;
  }
  guest.sendPrompt(text, images);
  return true;
}

/** Same routing for interrupts: returns true when the abort was relayed (or nothing to abort locally). */
export function relayGuestAbort(sessionId: string): boolean {
  const rt = liveRuntime(sessionId);
  const guest = rt?.guest;
  if (!guest || rt!.ctx.collabGuest !== guest) return false;
  guest.sendAbort();
  return true;
}
