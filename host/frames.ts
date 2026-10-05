// Frame assembly layer: the models/settings frames are shared by several rpc
// domains and main's ready frame. It is a separate layer because
// settingsFrame combines models.ts snapshots with switch reads from
// profile/assets; sinking it into either side would create a cycle (the
// profile->models edge already exists) — carried over from the original
// main.ts comment "do not sink models.ts, avoid module cycles".
import { H } from "./state.ts";
import { modelsPayload, modelsDefaults, modelRolesPayload, settingsSnapshot } from "./models.ts";
import { readAcpConfig, readAcpEnabled, readSessionContextEnabled } from "./profile.ts";
import { readKeepaliveEnabled, readKeepaliveProbeConfig } from "./keepalive-config.ts";
import { readHooksEnabled, readPluginsEnabled } from "./assets.ts";
import { readUiConfig } from "./ui-config.ts";
import { readExternalBrowserEnabled } from "./browser-config.ts";
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
  };
}
