// Startup and config-domain frames: the ready handshake, model catalog, settings snapshot/schema,
// profile switch, approval mode, usage stats, asset lists, extension lists. Moved over from
// store/ws.ts onMessage.
import { useAppStore } from "../index";
import { applyUiConfig, applyColorBlindMode } from "../../appearance";
import { hostInstanceReset } from "../session";
import { ingestModelDefaults, ingestModels } from "../models";
import { clearRightSlots, resetBrowserMirrorUi } from "../right";
import { t } from "../../i18n";
import type { ApprovalMode } from "../../types/frames";
import type { SchemaDef } from "../../types/settings";
import type { HandlerSlice } from "./types";

export const configHandlers = {
  ready(msg) {
    // The handshake frame takes no seq: reset only when the instance changes; on reconnect (same hi) keep the seen position to avoid false gaps
    const st = useAppStore.getState();
    // A fresh host instance means the browser-mirror poll restarted: drop the
    // stale tab list until the page resubscribes (auto-open latch included).
    if (msg.hi && st.evtHost !== msg.hi) {
      hostInstanceReset(msg.hi, 0);
      resetBrowserMirrorUi();
    }
    // approvalMode is an un-narrowed string on the host side (same as SettingsSnapshot.approvalMode); the three-value validation lives in the host
    const approvalMode = (msg.approvalMode as ApprovalMode | undefined) ?? st.approvalMode;
    ingestModels(msg.models);
    if (msg.roles) useAppStore.setState({ modelRoles: msg.roles });
    useAppStore.setState({ approvalMode });
    // When the welcome page shows at startup, the ready frame arrives after the first initNewSessionModel: recalibrate immediately once config defaults land
    if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
      useAppStore.getState().initNewSessionModel(true);
    }
    if (msg.settings) {
      // File-first reconcile (omp-desktop.json ui section) BEFORE the host-settings
      // hideThinkingBlock overlay: the base settings stay the authority for showThinking
      applyUiConfig(msg.settings.uiConfig);
      // Field-level whitelist merge: only hideThinkingBlock in the host settings frame affects local appearance prefs
      if (typeof msg.settings.hideThinkingBlock === "boolean") {
        useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
      }
      applyColorBlindMode(msg.settings.values?.colorBlindMode);
      useAppStore.setState({ hostSettings: msg.settings });
      // Master gate closed: drop any pending create intent so a session born
      // after this never carries a stale computerMode:true
      if (msg.settings.computerEnabled !== true && useAppStore.getState().newSessionComputerMode) {
        useAppStore.setState({ newSessionComputerMode: false });
      }
    }
  },
  models(msg) {
    ingestModels(msg.models);
    if (msg.roles) useAppStore.setState({ modelRoles: msg.roles });
    if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
      useAppStore.getState().initNewSessionModel(true);
    }
  },
  models_catalog(msg) {
    useAppStore.setState((s) => ({ modelCatalog: msg.models ?? [] }));
  },
  model_roles(msg) {
    useAppStore.setState({ modelRoles: msg.roles ?? [] });
  },
  capability_keys(msg) {
    useAppStore.setState({ capabilityKeys: msg.keys ?? [] });
    // A key save/clear can flip an engine's availability — refetch so the web-search picker filters on fresh data
    useAppStore.getState().send({ type: "get_search_availability" });
  },
  search_availability(msg) {
    useAppStore.setState({ searchAvailability: msg.availability ?? {} });
  },
  settings(msg) {
    // Same ordering as the ready handler: file-first reconcile, then the host overlay
    applyUiConfig(msg.settings?.uiConfig);
    if (typeof msg.settings?.hideThinkingBlock === "boolean") {
      useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
    }
    applyColorBlindMode(msg.settings?.values?.colorBlindMode);
    useAppStore.setState({ hostSettings: msg.settings });
    if (msg.settings?.computerEnabled !== true && useAppStore.getState().newSessionComputerMode) {
      useAppStore.setState({ newSessionComputerMode: false }); // same gate-close cleanup as the ready handler above
    }
    if (msg.restartHint) useAppStore.getState().toast(t("notify.savedRestartHint"));
  },
  settings_schema(msg) {
    // Host schema entries are exactly the SETTINGS_SCHEMA shape (aligned with SchemaDef); the frame side is coarse for now, narrowed at the boundary
    useAppStore.setState((s) => ({ settingsSchema: msg.schema as Record<string, SchemaDef> }));
  },
  profile_switched(msg) {
    clearRightSlots(); // profile switch = different session universe, per-session slots (and their resources) no longer trustworthy
    useAppStore.setState((s) => ({
      openSessions: new Map(),
      activePath: null,
      selectedSubagent: null,
      selectedFile: null,
    }));
    useAppStore.getState().toast(t("notify.profileActivated", { profile: msg.profile }));
  },
  usage_stats(msg) {
    useAppStore.setState((s) => ({ usageStats: msg.stats }));
  },
  agent_assets(msg) {
    // Skill/asset toggles land here: drop the composer's cached command list
    // so the next $ // / completion refetches it (the cache key alone would
    // keep serving the pre-toggle list — disabled skills stayed, enabled ones
    // stayed hidden).
    useAppStore.setState((s) => ({ agentAssets: msg.assets, commands: null, commandsSessionId: null }));
  },
  extensions(msg) {
    useAppStore.setState((s) => ({
      extensions: msg,
      extensionsByScope: { ...s.extensionsByScope, [msg.scope]: msg },
    }));
  },
  approval_mode(msg) {
    useAppStore.setState((s) => ({ approvalMode: msg.mode }));
  },
  ssh_hosts(msg) {
    useAppStore.setState({ sshHosts: msg.hosts ?? [] });
  },
  ssh_test_result(msg) {
    const { type: _type, ...rest } = msg;
    useAppStore.setState({ sshTestResult: { ...rest, ts: Date.now() } });
  },
  remote_workspace_added(msg) {
    const { type: _type, ...rest } = msg;
    useAppStore.setState({ remoteWorkspaceAdded: { ...rest, ts: Date.now() } });
  },
  ssh_dirs(msg) {
    const { type: _type, ...rest } = msg;
    useAppStore.setState({ sshDirs: { ...rest, ts: Date.now() } });
  },
} satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type ConfigFrames = keyof typeof configHandlers;
