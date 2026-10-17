// RPC handler aggregation and dispatch. Merges the thirteen domain handler
// tables; unknown commands reply with the error frame (matching the old switch
// default). Exceptions are caught by the message shell in main.ts and returned
// as error frames. Exhaustiveness is guarded by the RPC manifest check in
// scripts/check-capabilities.mjs (every listed method resolvable); the handler
import { sessionHandlers } from "./session";
import { promptHandlers } from "./prompt";
import { filesHandlers } from "./files";
import { modelsHandlers } from "./models";
import { settingsHandlers } from "./settings";
import { loginHandlers } from "./login";
import { assetsHandlers } from "./assets";
import { terminalHandlers } from "./terminal";
import { limitsHandlers } from "./limits";
import { wizardHandlers } from "./provider-wizard";
import { capabilitiesHandlers } from "./capabilities";
import { browserHandlers } from "./browser";
import { sshHandlers } from "./ssh";
import { voiceHandlers } from "./voice";
import { bashCompleteHandlers } from "./bash-complete";
import { automationsHandlers } from "./automations";
import { btwHandlers } from "./btw";
import { remoteHandlers } from "./remote";
import { REMOTE_WRITE_DENYLIST } from "../remote.ts";
import { hostI18n } from "../i18n/host.ts";

export const rpcHandlers: Record<string, RpcHandler> = {
  ...sessionHandlers,
  ...promptHandlers,
  ...filesHandlers,
  ...modelsHandlers,
  ...settingsHandlers,
  ...loginHandlers,
  ...assetsHandlers,
  ...terminalHandlers,
  ...limitsHandlers,
  ...wizardHandlers,
  ...capabilitiesHandlers,
  ...browserHandlers,
  ...sshHandlers,
  ...voiceHandlers,
  ...bashCompleteHandlers,
  ...automationsHandlers,
  ...btwHandlers,
  ...remoteHandlers,
};

/** Single-command dispatch: table lookup + invoke; unknown commands reply with error (old switch default semantics) */
export function dispatchRpc(ws: any, msg: any): void | Promise<void> {
  // Remote (LAN) connections are read-only for the write domains (spec §3.5):
  // denylisted RPCs error out before any handler runs, leaving disk state untouched.
  if (ws.data?.remote === true && REMOTE_WRITE_DENYLIST.has(String(msg.type))) {
    ws.send(JSON.stringify({ type: "error", message: "remote read-only" }));
    return;
  }
  const h = rpcHandlers[msg.type as string];
  if (!h) {
    ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.unknownCommand", { type: msg.type }) }));
    return;
  }
  return h(ws, msg);
}
