// Computer-use session state: the composer's screen-icon toggle between the
// "Plan" button and the background-task buttons. Mirrors the per-session
// `computer.enabled` runtime overlay (pinned off at spawn in
// session-lifecycle; the base's /computer on|off writes the same layer, so
// the button and the command stay in lockstep). The settings-page master
// gate (H.settings) is checked before any enable. Frame contract follows
// plan.ts's plan_mode: push an explicit state after every mutation path so
// the button never relies on a stale read.
import { hostI18n } from "../ui-src/i18n/host.ts";
import { H, pushCommandOutput, type PoolEntry } from "./state.ts";
import { lookupSetting } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";

const COMPUTER_ENABLED = "computer.enabled";

/** Computer-use state frame: the composer's screen-icon button lights up on it. */
export function pushComputerMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  ws.send(
    JSON.stringify({
      type: "computer_mode",
      sessionId,
      enabled: settingsGet(entry.session.settings, COMPUTER_ENABLED) === true,
    }),
  );
}

/**
 * Toggle the per-session computer-use overlay (runtime layer, never
 * persisted — the same write the base's /computer on|off performs). Enabling
 * checks the settings-page master gate first and rolls back when the eval
 * prelude cannot activate; both failure paths keep the state unchanged,
 * surface a command_output line, and re-push the frame so the button
 * reflects reality.
 */
export function setComputerMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
): void {
  const gate = lookupSetting(COMPUTER_ENABLED);
  if (!gate) throw new Error(`Unknown setting: ${COMPUTER_ENABLED}`);
  if (enabled && !settingsGet(H.settings, COMPUTER_ENABLED)) {
    pushCommandOutput(sessionId, hostI18n.t("errors.computerGateClosed"));
    pushComputerMode(ws, sessionId, entry);
    return;
  }
  const previous = settingsGet(entry.session.settings, COMPUTER_ENABLED) === true;
  entry.session.settings.writeValue(gate, enabled, "override");
  if (enabled && !entry.session.getEvalPreludes().some((d) => d?.name === "computer")) {
    entry.session.settings.writeValue(gate, previous, "override");
    pushCommandOutput(sessionId, hostI18n.t("errors.computerUnavailable"));
  }
  pushComputerMode(ws, sessionId, entry);
}
