// Settings center slice: open state/current page, host settings and schema, model catalog and roles,
// provider management views, login flow state, asset editor (skills/agents/mcp/memory) reply
// landing. Moved over from store.ts (P3 wave 2).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type {
  ProviderAccountsFrame,
  ProviderLimitsResultFrame,
  LoginPromptFrame,
  AssetFileFrame,
  SettingsPayload,
  CapabilityKeyEntry,
  AllProviderEntry,
  UsageStats,
  AgentAssetsPayload,
  ManualProbeModel,
  ManualProbeCatalogMatch,
  ExtensionsFrame,
  DisplaysFrame,
  SshHostsFrame,
  SshTestResultFrame,
  RemoteWorkspaceAddedFrame,
} from "../types/frames";
import type { MemoryDetailState } from "../types/session";
import type { SchemaDef } from "../types/settings";

export interface SettingsSlice {
  settingsOpen: boolean; // fullscreen overlay open state
  settingsPage: string; // current settings page id
  hostSettings: SettingsPayload | null;
  settingsSchema: Record<string, SchemaDef> | null; // entry shape matches SETTINGS_SCHEMA
  capabilityKeys: CapabilityKeyEntry[] | null;
  searchAvailability: Record<string, boolean> | null; // get_search_availability reply (null = not fetched yet); keys are catalog ids "web/<engine>"
  selectedProvider: string | null;
  mpAddView: boolean;
  mpRolesView: boolean;
  mpCycleView: boolean; // ctrl+p quick-switch cycle-order editor (left-column subpage under model roles)
  mpDetailProv: AllProviderEntry | null; // current provider on the provider detail page (written by card clicks)
  allProvidersCache: AllProviderEntry[] | null; // all_providers reply cache (add-view card grid)
  mpManualView: boolean; // manual-add wizard view (nested under mpAddView)
  manualProbe: { models: ManualProbeModel[]; failed: boolean; message?: string; at: number } | null; // latest probe reply
  manualProbing: boolean; // probe request in flight
  manualSaving: boolean; // save request in flight
  manualModelSaving: string | null; // per-model metadata save in flight (model id)
  providerMeta: { provider: string; exists: boolean; rows: Record<string, { saved: ManualProbeCatalogMatch | null; catalog: ManualProbeCatalogMatch | null }> } | null; // provider_model_meta reply (detail-list editor prefill)
  modelTestResults: Record<string, { status: "running" | "ok" | "fail"; latencyMs?: number; message?: string; reply?: string; ts: number }>; // per-model connectivity test (provider_model_test reply)
  loginBusy: boolean;
  loginReqId: number;
  loginBanner: string | null; // OMP login progress banner text
  loginPromptData: LoginPromptFrame | null; // login_prompt paste-code dialog data
  agentAssets: AgentAssetsPayload | null;
  extensions: ExtensionsFrame | null; // extension-hub data frame (list_extensions / toggle_* replies)
  extensionsByScope: Record<string, ExtensionsFrame>; // same as above but accumulated per scope (for cross-scope matching of source badges on the assets page)
  usageStats: UsageStats | null;
  providerLimits: ProviderLimitsResultFrame | null; // provider_limits_result quota frame
  providerAccounts: ProviderAccountsFrame | null; // provider_accounts account list frame
  assetFile: AssetFileFrame | null; // asset_file reply (skills/agents editors filter by kind)
  assetFileSaved: { kind: string; at: number } | null; // landed from asset_file_saved (reference change drives the "saved" indicator)
  assetSaved: { kind: string; at: number } | null; // same as above, consumed by the agents page
  assetErr: { kind: string; message: string; at: number } | null; // landed when the error frame carries kind
  computerDisplays: DisplaysFrame | null; // list_displays reply: physical displays for the computer-control dropdown (null = not yet detected)
  sshHosts: SshHostsFrame["hosts"]; // user-scope ssh.json host table (welcome remote-connection dialog)
  sshTestResult: (Omit<SshTestResultFrame, "type"> & { ts: number }) | null; // latest connectivity probe (ts correlates replies)
  remoteWorkspaceAdded: (Omit<RemoteWorkspaceAddedFrame, "type"> & { ts: number }) | null; // latest add_remote_workspace reply (dialog closes itself on ok)
  mcpTestResults: Record<string, { status: string; error?: string; log?: string; ts: number }>; // per-server MCP test results
  memoryDetail: MemoryDetailState; // landed from the memory_file frame
  openSettings(pageId?: string): void;
  closeSettings(): void;
  refreshSettingsData(): void;
}

export const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set, get) => ({
  settingsOpen: false,
  settingsPage: "pg-general",
  hostSettings: null,
  settingsSchema: null,
  capabilityKeys: null,
  searchAvailability: null,
  selectedProvider: null,
  mpAddView: false,
  mpRolesView: false,
  mpCycleView: false,
  mpDetailProv: null,
  allProvidersCache: null,
  loginBusy: false,
  loginReqId: 0,
  loginBanner: null,
  loginPromptData: null,
  agentAssets: null,
  mpManualView: false,
  manualProbe: null,
  manualProbing: false,
  manualSaving: false,
  manualModelSaving: null,
  modelTestResults: {},
  providerMeta: null,
  extensions: null,
  extensionsByScope: {},
  usageStats: null,
  providerLimits: null,
  providerAccounts: null,
  assetFile: null,
  assetFileSaved: null,
  assetSaved: null,
  assetErr: null,
  sshHosts: [],
  sshTestResult: null,
  remoteWorkspaceAdded: null,
  mcpTestResults: {},
  computerDisplays: null,
  memoryDetail: { base: null, files: null, rollouts: [], active: null, status: "idle", content: "", error: null },

  openSettings(pageId = "pg-general") {
    set((s) => ({ settingsOpen: true, settingsPage: pageId }));
  },
  closeSettings() {
    set((s) => ({ settingsOpen: false }));
  },
  // The data-request burst when the settings center opens (moved over from the old
  // refreshSettingsData; send silently drops while not connected, and the connect onopen
  // refetches once the connection is ready)
  refreshSettingsData() {
    if (!get().settingsSchema) get().send({ type: "get_settings_schema" });
    get().send({ type: "get_settings" });
    get().send({ type: "get_models_catalog" });
    get().send({ type: "get_capability_keys" });
    get().send({ type: "get_search_availability" });
    get().send({ type: "list_agent_assets" });
    get().send({ type: "get_usage_stats" });
  },
});
