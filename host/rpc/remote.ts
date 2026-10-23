// Remote-control config RPCs (spec §3.2): drive the LAN remote server
// (enable/disable/rebind) and its access key. Both are callable from local and
// remote connections alike — configuring the remote service is not part of the
// settings-write denylist (spec §3.5); the denylist guards profile/settings
// state, not the remote switch itself.

import { pushSettings } from "../frames.ts";
import {
  generateRemoteAccessKey,
  readRemoteConfig,
  remoteStatus,
  startRemoteServer,
  stopRemoteServer,
  writeRemoteConfig,
} from "../remote.ts";
import type { RpcHandler } from "./types";

export const remoteHandlers: Record<string, RpcHandler> = {
  async set_remote_config(ws, msg) {
    const cur = readRemoteConfig();
    const wantEnabled = typeof msg.enabled === "boolean" ? msg.enabled : cur.enabled;
    const wantPort =
      typeof msg.port === "number" && Number.isInteger(msg.port) && msg.port > 0 && msg.port <= 65535 ? msg.port : cur.port;
    // Display preference of the narrow client, not server state: it never touches the
    // running server, so it rides along in both branches below.
    const wantMobileStatsBar = typeof msg.mobileStatsBar === "boolean" ? msg.mobileStatsBar : cur.mobileStatsBar;
    // A request that only carries the display preference must not start/rebind the server:
    // otherwise toggling the phone stats bar would fail (and never persist) on any machine
    // where the port is held by another host — e.g. the dev profile while the default
    // profile's remote service owns 16800.
    const touchesServer = typeof msg.enabled === "boolean" || typeof msg.port === "number";
    let error: string | undefined;
    if (!touchesServer) {
      writeRemoteConfig({ mobileStatsBar: wantMobileStatsBar });
    } else if (wantEnabled) {
      const r = startRemoteServer(wantPort);
      if (r.ok) {
        // First enable mints the access key (spec §3.1 "generated on enable")
        const accessKey = cur.accessKey || generateRemoteAccessKey();
        writeRemoteConfig({ enabled: true, port: r.port!, accessKey, mobileStatsBar: wantMobileStatsBar });
      } else {
        // Bind failure: report and keep the previous server/config untouched (spec §3.2)
        error = r.error;
      }
    } else {
      stopRemoteServer();
      writeRemoteConfig({ enabled: false, port: wantPort, mobileStatsBar: wantMobileStatsBar });
    }
    const st = remoteStatus();
    const cfg = readRemoteConfig();
    ws.send(
      JSON.stringify({
        type: "remote_config",
        enabled: st.enabled,
        port: st.enabled ? st.port : cfg.port,
        ...(error ? { error } : {}),
      }),
    );
    // Success pushes a settings frame so every connected UI refreshes the remote section
    if (!error) pushSettings();
  },

  remote_regenerate_key(ws) {
    const accessKey = generateRemoteAccessKey();
    writeRemoteConfig({ accessKey });
    // The old key dies immediately: new upgrades fail 401, existing sockets stay connected (spec §3.2)
    ws.send(JSON.stringify({ type: "remote_key", key: accessKey }));
    // remote.url embeds the key: a stale url makes the settings page's copy-link hand out
    // the dead key (browser opens it, handshake 401s, the 1006 probe wipes the stored key)
    pushSettings();
  },
};
