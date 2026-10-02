// Settings center slice: open state/current page, host settings and schema, model catalog and roles,
// provider management views, login flow state, asset editor (skills/agents/mcp/memory) reply
// landing. Moved over from store.ts (P3 wave 2).
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type {
  ProviderLimitsResultFrame,
  LoginPromptFrame,
  AssetFileFrame,
  SettingsPayload,
  ModelCatalogEntry,
  ModelRoleEntry,
  AllProviderEntry,
  UsageStats,
  AgentAssetsPayload,
  ExtensionsFrame,
} from "../types/frames";
import type { MemoryDetailState } from "../types/session";
import type { SchemaDef } from "../components/settings/placement";

export interface SettingsSlice {
  settingsOpen: boolean; // fullscreen overlay open state
  settingsPage: string; // current settings page id
  hostSettings: SettingsPayload | null;
  settingsSchema: Record<string, SchemaDef> | null; // entry shape matches SETTINGS_SCHEMA
  modelCatalog: ModelCatalogEntry[];
  modelRoles: ModelRoleEntry[] | null;
  selectedProvider: string | null;
  mpAddView: boolean;
  mpRolesView: boolean;
  mpDetailProv: AllProviderEntry | null; // current provider on the provider detail page (written by card clicks)
  allProvidersCache: AllProviderEntry[] | null;
  loginBusy: boolean;
  loginReqId: number;
  loginBanner: string | null; // OMP login progress banner text
  loginPromptData: LoginPromptFrame | null; // login_prompt paste-code dialog data
  agentAssets: AgentAssetsPayload | null;
  extensions: ExtensionsFrame | null; // extension-hub data frame (list_extensions / toggle_* replies)
  extensionsByScope: Record<string, ExtensionsFrame>; // same as above but accumulated per scope (for cross-scope matching of source badges on the assets page)
  usageStats: UsageStats | null;
  providerLimits: ProviderLimitsResultFrame | null; // provider_limits_result quota frame
  assetFile: AssetFileFrame | null; // asset_file reply (skills/agents editors filter by kind)
  assetFileSaved: { kind: string; at: number } | null; // landed from asset_file_saved (reference change drives the "saved" indicator)
  assetSaved: { kind: string; at: number } | null; // same as above, consumed by the agents page
  assetErr: { kind: string; message: string; at: number } | null; // landed when the error frame carries kind
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
  modelCatalog: [],
  modelRoles: null,
  selectedProvider: null,
  mpAddView: false,
  mpRolesView: false,
  mpDetailProv: null,
  allProvidersCache: null,
  loginBusy: false,
  loginReqId: 0,
  loginBanner: null,
  loginPromptData: null,
  agentAssets: null,
  extensions: null,
  extensionsByScope: {},
  usageStats: null,
  providerLimits: null,
  assetFile: null,
  assetFileSaved: null,
  assetSaved: null,
  assetErr: null,
  mcpTestResults: {},
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
    get().send({ type: "list_agent_assets" });
    get().send({ type: "get_usage_stats" });
  },
});
