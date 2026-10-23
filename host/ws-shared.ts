// Shared WebSocket open/message/close handlers for BOTH Bun.serve instances:
// the primary server (host/main.ts, Tauri channel) and the LAN remote server
// (host/remote.ts). Protocol behavior is identical for both (spec §3.3); the
// only distinguishing input is ws.data.remote, stamped at upgrade time in
// remote.ts and used by dispatchRpc for the write denylist.
import { H, HOST_INSTANCE_ID, activeWs, activeRemoteWs, eachUiWs, sessions } from "./state.ts";
import { hostI18n } from "./i18n/host.ts";
import { modelsPayload, modelsDefaults, modelRolesPayload } from "./models.ts";
import { settingsFrame } from "./frames.ts";
import { dispatchRpc } from "./rpc/index.ts";
import { detachEntryUi } from "./session-entry-core.ts";
import { recordRemoteDevice } from "./remote.ts";
import { browserMirrorOnWsOpen, browserMirrorOnWsClose } from "./browser-mirror.ts";
import { settingsGet } from "./settings-compat.ts";
import { safeStderr } from "./stderr.ts";

/** Structural minimum both servers' sockets satisfy (kept loose so one handler set serves both serve() instantiations). */
export interface HostWs {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  data?: { sessionId?: string | null; remote?: boolean; meta?: { ua: string; ip: string } };
}

export function makeWsHandlers(profileReady: Promise<unknown>): Bun.WebSocketHandler<unknown> {
  return {
    open(ws: HostWs) {
      // Channel-scoped takeover (spec §3.4): each channel — local desktop vs
      // remote control — allows exactly one concurrent connection; a new open
      // kicks only its own channel's previous holder, so remote access never
      // evicts the local desktop and vice versa.
      const remote = ws.data?.remote === true;
      const slot = remote ? activeRemoteWs : activeWs;
      const prev = slot.value as HostWs | null;
      if (prev && prev !== ws) {
        try {
          prev.send(JSON.stringify({ type: "kicked" }));
          prev.close(4001, "kicked");
        } catch {
          // A half-dead previous socket must not block the takeover
        }
      }
      slot.value = ws; // close clears only its own channel's slot
      if (remote && ws.data?.meta && recordRemoteDevice(ws.data.meta)) {
        // Device history changed: refresh the settings page card on every connected UI
        const data = JSON.stringify({ type: "settings", settings: settingsFrame() });
        eachUiWs((ui) => ui.send(data));
      }
      browserMirrorOnWsOpen(ws);
      safeStderr(hostI18n.t("errors.host.wsClientReady", { ms: performance.now().toFixed(0) }));
      void profileReady.then(
        () => {
          ws.send(
            JSON.stringify({
              type: "ready",
              hi: HOST_INSTANCE_ID, // The handshake takes no event seq, but carries instance identity for immediate UI comparison
              approvalMode: settingsGet(H.settings, "tools.approvalMode"),
              models: modelsPayload(),
              roles: modelRolesPayload(),
              ...modelsDefaults(),
              settings: settingsFrame(),
            }),
          );
        },
        (err: unknown) => {
          ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        },
      );
    },
    async message(ws: HostWs, raw: unknown) {
      try {
        await profileReady;
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.invalidJson") }));
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.invalidJson") }));
        return;
      }
      // Shape: a parsed JSON object frame; only type/sessionId/kind are read here, dispatchRpc owns the rest.
      const msg = parsed as { type: string; sessionId?: unknown; kind?: unknown };
      try {
        await dispatchRpc(ws, msg);
      } catch (err) {
        // A single failed command must not take down the host; report the error to the frontend as-is
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        safeStderr(hostI18n.t("errors.host.commandFailed", { type: msg.type, detail: String(err) }));
      }
    },
    close(ws: HostWs) {
      // Channel slot: a socket can only ever hold its own channel's slot (the
      // channel is stamped at upgrade time), but check both defensively.
      if (activeWs.value === ws) activeWs.value = null;
      if (activeRemoteWs.value === ws) activeRemoteWs.value = null;
      // Per-session detach: drop the socket from every pool entry it watches
      // (its subagent view goes with it); the last watcher leaving tears the
      // entry's core subscriptions down via entry.unsubscribe.
      for (const entry of sessions.values()) detachEntryUi(ws, entry);
      browserMirrorOnWsClose(ws);
    },
  };
}
