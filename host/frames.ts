// Frame assembly layer: the models/settings frames are shared by several rpc
// domains and main's ready frame. It is a separate layer because
// settingsFrame combines models.ts snapshots with switch reads from
// profile/assets; sinking it into either side would create a cycle (the
// profile->models edge already exists) — carried over from the original
// main.ts comment "do not sink models.ts, avoid module cycles".
import { H } from "./state.ts";
import { modelsPayload, modelsDefaults, settingsSnapshot } from "./models.ts";
import { readAcpConfig, readAcpEnabled, readSessionContextEnabled } from "./profile.ts";
import { readKeepaliveEnabled, readKeepaliveProbeConfig } from "./keepalive-config.ts";
import { readHooksEnabled, readPluginsEnabled } from "./assets.ts";

// Unified models frame assembly: catalog + config defaults for new sessions
// (defaultModel/defaultThinking), shared by every send site to avoid missing
// default fields
export function modelsFrame() {
  return { type: "models", models: modelsPayload(), ...modelsDefaults() };
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
    skillsEnabled: !!H.settings.get("skills.enabled"),
  };
}
