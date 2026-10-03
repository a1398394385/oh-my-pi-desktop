// Capabilities domain RPC: the active session's subsystem runtime snapshot
// (right-panel capabilities page).
import { sessions } from "../state.ts";
import { buildCapabilitiesSnapshot } from "../capabilities.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

export const capabilitiesHandlers: Record<string, RpcHandler> = {
  async get_capabilities(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
    ws.send(JSON.stringify({ type: "capabilities", snapshot: await buildCapabilitiesSnapshot(entry, sessionId) }));
  },
};
