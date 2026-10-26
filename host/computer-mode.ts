// Computer-use session state: the composer's screen-icon toggle between the
// "Plan" button and the background-task buttons, plus the settings-page
// provider pick (default = OMP builtin, kimi = the kimi-cu MCP server).
//
// Default provider: mirrors the per-session `computer.enabled` runtime
// overlay (pinned off at spawn in session-lifecycle; the base's /computer
// on|off writes the same layer, so the button and the command stay in
// lockstep). The settings-page master gate (H.settings) is checked before
// any enable.
//
// Kimi provider: the same button instead mounts/unmounts the kimi-cu MCP
// server into this session's tool surface mid-session (host/mcp-mount.ts).
// /computer on arms the default overlay under this provider too, so the
// icon-off path clears both — see setComputerMode.
// The server definition is code-owned (host/mcp-builtin.ts, never in
// mcp.json) and never auto-mounts at pool boundaries — only sessions the
// user opted into carry its tools. Picking the provider warms the shared
// global connection (warmKimiCu, also re-run at every profile apply). The
// frame's enabled flag is the overlay OR the mounted state; its optional
// error field makes the composer toggle's failures visible as a toast.
import { H, pushCommandOutput, sendSessionState, type PoolEntry } from "./state.ts";
import { lookupSetting } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { KIMI_CU_SERVER, kimiCuInstalled, warmBuiltinServer } from "./mcp-builtin.ts";
import { hostI18n } from "./i18n/host.ts";
import { isServerMounted, mountServerForSession, unmountServerForSession } from "./mcp-mount.ts";
import { safeStderr } from "./stderr.ts";

const COMPUTER_ENABLED = "computer.enabled";

export type ComputerProvider = "default" | "kimi";

/** Read the `computer` section of omp-desktop.json (missing/invalid -> empty). */
function readComputerSection(): Record<string, unknown> {
  return readDesktopSection("computer");
}

/** Desktop-owned provider pick; missing/invalid counts as "default" (only an explicit "kimi" opts in). */
export function readComputerProvider(): ComputerProvider {
  return readComputerSection().provider === "kimi" ? "kimi" : "default";
}

/** Persist the provider pick (merge-write; the rest of the file and section survive). */
export function writeComputerProvider(provider: ComputerProvider): void {
  writeDesktopSection("computer", { ...readComputerSection(), provider });
}

/**
 * Desktop-owned "default on" switch (omp-desktop.json computer.defaultEnabled):
 * fresh sessions start with computer use enabled instead of waiting for the
 * composer click / `/computer on`. Sessions already on disk are untouched —
 * the value is read at spawn only.
 */
export function readComputerDefaultEnabled(): boolean {
  return readComputerSection().defaultEnabled === true;
}

/** Persist the default-on switch (merge-write, same contract as the provider pick). */
export function writeComputerDefaultEnabled(enabled: boolean): void {
  writeDesktopSection("computer", { ...readComputerSection(), defaultEnabled: enabled });
}

/**
 * Whether a freshly spawned session should start opted in. User sessions follow the desktop
 * default; automation runs follow the automation's own flag instead — the desktop default
 * deliberately never applies there (an unattended scheduled run must not drive the desktop
 * unless the user asked for that task to). Either way the master gate must be open: a closed
 * gate force-closes every opt-in, so enabling here would just bounce off the rollback.
 */
export function computerDefaultAppliesFor(automation?: { computer?: boolean }): boolean {
  if (settingsGet(H.settings, COMPUTER_ENABLED) !== true) return false;
  return automation ? automation.computer === true : readComputerDefaultEnabled();
}

/**
 * Warm the builtin kimi-cu connection when the provider pick says kimi
 * (profile apply + provider switch). Fire-and-forget: the warm failure only
 * logs — the composer toggle surfaces the real error on use.
 */
export function warmKimiCu(): void {
  if (readComputerProvider() !== "kimi") return;
  void warmBuiltinServer(KIMI_CU_SERVER).then((ok) => {
    if (!ok) safeStderr(hostI18n.t("errors.computer.kimiCuWarmFailed"));
  });
}

/**
 * The composer button's lit state: EITHER opt-in source alone lights it — the
 * per-session `computer.enabled` overlay (default provider's eval prelude,
 * armed by the base's /computer or setComputerMode) or a live kimi-cu mount.
 * Single definition: every reader (frame push, /computer toggle+status in
 * rpc/prompt.ts) must see the same OR or the button and the command fork.
 */
export function computerModeActive(sessionId: string, entry: PoolEntry): boolean {
  return settingsGet(entry.session.settings, COMPUTER_ENABLED) === true || isServerMounted(sessionId, KIMI_CU_SERVER);
}

/** Computer-use state frame: the composer's screen-icon button lights up on it. */
export function pushComputerMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  error?: string,
) {
  // Both attached channels light the composer's screen icon from this frame
  sendSessionState(
    ws,
    entry,
    JSON.stringify({
      type: "computer_mode",
      sessionId,
      enabled: computerModeActive(sessionId, entry),
      ...(error ? { error } : {}),
    }),
  );
}

/**
 * Toggle the per-session computer-use opt-in for the active provider.
 *
 * Off is provider-independent: it clears the per-session `computer.enabled`
 * overlay AND drops any kimi-cu mount. The base's /computer on arms that
 * overlay under ANY provider, and pushComputerMode ORs overlay+mount into
 * the lit state — the kimi branch used to unmount only, so a /computer-on
 * session kept the icon lit and the click did nothing.
 *
 * On is provider-aware. Default: writes the overlay (settings-page master
 * gate checked first; rolled back when the eval prelude cannot activate).
 * Kimi: mounts the builtin kimi-cu MCP server (mcp-builtin.ts) mid-session,
 * immediate; requires KimiCU installed. Every failure path keeps the state
 * unchanged, surfaces a command_output line plus the frame's error field
 * (frontend red toast), and re-pushes the frame so the button reflects reality.
 */
export async function setComputerMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
): Promise<void> {
  const gate = lookupSetting(COMPUTER_ENABLED);
  if (!gate) throw new Error(`Unknown setting: ${COMPUTER_ENABLED}`);
  if (!enabled) {
    unmountServerForSession(sessionId, entry, KIMI_CU_SERVER);
    entry.session.settings.writeValue(gate, false, "override");
    pushComputerMode(ws, sessionId, entry);
    return;
  }
  if (readComputerProvider() === "kimi") {
    if (!kimiCuInstalled()) {
      const msg = hostI18n.t("errors.kimiCuNotInstalled");
      pushCommandOutput(sessionId, msg);
      pushComputerMode(ws, sessionId, entry, msg);
    } else if (!(await mountServerForSession(sessionId, entry, KIMI_CU_SERVER))) {
      const msg = hostI18n.t("errors.kimiCuConnectFailed");
      pushCommandOutput(sessionId, msg);
      pushComputerMode(ws, sessionId, entry, msg);
    } else {
      pushComputerMode(ws, sessionId, entry);
    }
    return;
  }
  if (!settingsGet(H.settings, COMPUTER_ENABLED)) {
    const msg = hostI18n.t("errors.computerGateClosed");
    pushCommandOutput(sessionId, msg);
    pushComputerMode(ws, sessionId, entry, msg);
    return;
  }
  const previous = settingsGet(entry.session.settings, COMPUTER_ENABLED) === true;
  entry.session.settings.writeValue(gate, true, "override");
  if (!entry.session.getEvalPreludes().some((d) => d?.name === "computer")) {
    entry.session.settings.writeValue(gate, previous, "override");
    const msg = hostI18n.t("errors.computerUnavailable");
    pushCommandOutput(sessionId, msg);
    pushComputerMode(ws, sessionId, entry, msg);
    return;
  }
  pushComputerMode(ws, sessionId, entry);
}
