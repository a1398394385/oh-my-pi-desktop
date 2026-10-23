// Frame assembly layer: the models/settings frames are shared by several rpc
// domains and main's ready frame. It is a separate layer because
// settingsFrame combines models.ts snapshots with switch reads from
// profile/assets; sinking it into either side would create a cycle (the
// profile->models edge already exists) — carried over from the original
// main.ts comment "do not sink models.ts, avoid module cycles".
import { H, eachUiWs } from "./state.ts";
import { modelsPayload, modelsDefaults, modelRolesPayload, settingsSnapshot } from "./models.ts";
import { readAcpConfig, readAcpEnabled, readAutomationAgentEnabled, readSessionContextEnabled } from "./profile.ts";
import { readKeepaliveEnabled, readKeepaliveProbeConfig } from "./keepalive-config.ts";
import { readHooksEnabled, readPluginsEnabled } from "./plugin-assets.ts";
import { readUiConfig } from "./ui-config.ts";
import { readExternalBrowserEnabled } from "./browser-config.ts";
import { readKimiAutoThinking } from "./kimi-thinking.ts";
import { isAutoReviewEnabled, isSmartModeOffered } from "./auto-review.ts";
import { readBranchTitles, readSessionTitleRefresh } from "./session-titles.ts";
import { kimiCuInstalled } from "./mcp-builtin.ts";
import { readComputerDefaultEnabled, readComputerProvider } from "./computer-mode.ts";
import { remotePayload } from "./remote.ts";
import { settingsGet } from "./settings-compat.ts";

// Unified models frame assembly: catalog + config defaults for new sessions
// (defaultModel/defaultThinking) + the model-role snapshot (the composer
// model menu's "Model Role" section and the ctrl+p role cycle both read it),
// shared by every send site to avoid missing default fields
export function modelsFrame() {
  return { type: "models", models: modelsPayload(), roles: modelRolesPayload(), ...modelsDefaults() };
}

/** Settings frame = base settings snapshot + host-side experimental switches. */
export function settingsFrame() {
  return {
    ...settingsSnapshot(),
    acpConfig: readAcpConfig(),
    acpEnabled: readAcpEnabled(),
    sessionContextEnabled: readSessionContextEnabled(),
    automationAgentEnabled: readAutomationAgentEnabled(),
    keepaliveEnabled: readKeepaliveEnabled(),
    keepaliveConfig: readKeepaliveProbeConfig(),
    hooksEnabled: readHooksEnabled(),
    pluginsEnabled: readPluginsEnabled(),
    skillsEnabled: !!settingsGet(H.settings, "skills.enabled"),
    // omp-desktop.json ui-section projection (locale/theme/motion/prefs): the
    // authoritative source the frontend reconciles its localStorage cache against
    uiConfig: readUiConfig(),
    // omp-desktop.json browser.external: desktop-owned browser routing switch
    // (off = OMP launches the browser, relay/cdpUrl pinned off regardless of
    // what config.yml holds; on = config.yml's external routes apply again)
    externalBrowserEnabled: readExternalBrowserEnabled(),
    // omp-desktop.json computer.provider: desktop-owned computer-use provider
    // pick. The Kimi options additionally report whether KimiCU is installed
    // and whether the kimi-cu server entry exists in the user-level mcp.json
    // (the computer page's configure button writes it, globally disabled).
    computerProvider: readComputerProvider(),
    kimiCuInstalled: kimiCuInstalled(),
    // omp-desktop.json computer.defaultEnabled: fresh sessions start with computer use
    // on (spawn-time read; sessions already on disk are never touched)
    computerDefaultEnabled: readComputerDefaultEnabled(),
    // omp-desktop.json kimi.autoThinking: whether Kimi models are offered the
    // `auto` thinking level (off by default — each level switch re-bills the
    // whole prefix on Kimi; the providers-page switch on pg-providers)
    kimiAutoThinking: readKimiAutoThinking(),
    // omp-desktop.json autoReview.enabled: the LLM tool-approval gate in
    // uiCtx.select — explicit low/medium verdicts approve unseen, everything
    // else still shows the human card (experimental page switch)
    autoReviewEnabled: isAutoReviewEnabled(),
    // autoReview.offerSmartMode: whether the permission-mode menu shows the
    // "smart approval" row (the page switch); the gate above stays independent.
    autoReviewOfferMode: isSmartModeOffered(),
    // omp-desktop.json sessionTitles.refresh: regenerate the title after every
    // settled turn (one tiny-model call per turn; user-renamed sessions stay pinned)
    sessionTitleRefresh: readSessionTitleRefresh(),
    // omp-desktop.json sessionTitles.branchTitles: journal titles per branch and
    // mirror the active branch's title into the header on branch switch
    branchTitles: readBranchTitles(),
    // omp-desktop.json remote section (host/remote.ts): LAN remote-control
    // server config; the settings page's remote group reads/builds URLs from it
    remote: remotePayload(),
  };
}

/** Push the fresh settings snapshot to EVERY channel, not just the one that asked.
 *  Settings writes are local-only (the remote denylist blocks the rest), so the remote
 *  client's hostSettings copy otherwise stays frozen at connect time and every switch it
 *  mirrors locally (remote.mobileStatsBar, uiConfig locale/motion, tui.* prefs) goes stale. */
export function pushSettings(): void {
  const data = JSON.stringify({ type: "settings", settings: settingsFrame() });
  eachUiWs((w) => w.send(data));
}
