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
// The server definition is code-owned (host/mcp-builtin.ts, never in
// mcp.json) and never auto-mounts at pool boundaries — only sessions the
// user opted into carry its tools. Picking the provider warms the shared
// global connection (warmKimiCu, also re-run at every profile apply). The
// frame's enabled flag is the overlay OR the mounted state; its optional
// error field makes the composer toggle's failures visible as a toast.
import { H, pushCommandOutput, type PoolEntry } from "./state.ts";
import { lookupSetting } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { KIMI_CU_SERVER, kimiCuInstalled, warmBuiltinServer } from "./mcp-builtin.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";
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
    if (!ok) safeStderr("[computer] kimi-cu 预热失败（点击输入框图标时会重试连接）\n");
  });
}

/** Computer-use state frame: the composer's screen-icon button lights up on it. */
export function pushComputerMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  error?: string,
) {
  ws.send(
    JSON.stringify({
      type: "computer_mode",
      sessionId,
      enabled: settingsGet(entry.session.settings, COMPUTER_ENABLED) === true || isServerMounted(sessionId, KIMI_CU_SERVER),
      ...(error ? { error } : {}),
    }),
  );
}

/**
 * Toggle the per-session computer-use opt-in for the active provider.
 *
 * Default: writes the per-session `computer.enabled` runtime overlay (runtime
 * layer, never persisted — the same write the base's /computer on|off
 * performs). Enabling checks the settings-page master gate first and rolls
 * back when the eval prelude cannot activate; both failure paths keep the
 * state unchanged, surface a command_output line plus the frame's error
 * field (frontend red toast), and re-push the frame so the button reflects
 * reality.
 *
 * Kimi: mounts/unmounts the builtin kimi-cu MCP server (mcp-builtin.ts) in
 * this session's tool surface (mid-session, immediate). Enabling requires
 * KimiCU installed. Never rejects: every failure surfaces as a command_output
 * line + the frame's error field and the frame is re-pushed.
 */
export async function setComputerMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
): Promise<void> {
  if (readComputerProvider() === "kimi") {
    if (enabled) {
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
    } else {
      unmountServerForSession(sessionId, entry, KIMI_CU_SERVER);
      pushComputerMode(ws, sessionId, entry);
    }
    return;
  }

  const gate = lookupSetting(COMPUTER_ENABLED);
  if (!gate) throw new Error(`Unknown setting: ${COMPUTER_ENABLED}`);
  if (enabled && !settingsGet(H.settings, COMPUTER_ENABLED)) {
    const msg = hostI18n.t("errors.computerGateClosed");
    pushCommandOutput(sessionId, msg);
    pushComputerMode(ws, sessionId, entry, msg);
    return;
  }
  const previous = settingsGet(entry.session.settings, COMPUTER_ENABLED) === true;
  entry.session.settings.writeValue(gate, enabled, "override");
  if (enabled && !entry.session.getEvalPreludes().some((d) => d?.name === "computer")) {
    entry.session.settings.writeValue(gate, previous, "override");
    const msg = hostI18n.t("errors.computerUnavailable");
    pushCommandOutput(sessionId, msg);
    pushComputerMode(ws, sessionId, entry, msg);
    return;
  }
  pushComputerMode(ws, sessionId, entry);
}
