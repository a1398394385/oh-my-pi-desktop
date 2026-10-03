// RPC handler aggregation and dispatch. Merges the eleven domain handler tables;
// unknown commands reply with the error frame (matching the old switch
// default). Exceptions are caught by the message shell in main.ts and returned
// as error frames. Exhaustiveness is guarded by the RPC manifest check in
// scripts/check-capabilities.mjs (all 117 methods resolvable); the handler
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
import hostI18n from "../../ui-src/i18n/host";

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
};

/** Single-command dispatch: table lookup + invoke; unknown commands reply with error (old switch default semantics) */
export function dispatchRpc(ws: any, msg: any): void | Promise<void> {
  const h = rpcHandlers[msg.type as string];
  if (!h) {
    ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.unknownCommand", { type: msg.type }) }));
    return;
  }
  return h(ws, msg);
}
