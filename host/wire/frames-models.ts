// Settings/models/login/assets/extensions/terminal/browser frame members of the
// wire contract (A10). Shared payload shapes live in payloads.ts, the HostFrame
// union in index.ts.
import type {
  AgentAssetsPayload, AllProviderEntry, AssetKind, ModelCatalogEntry, ModelEntry, ModelRoleEntry,
  SettingsPayload, UsageStats,
} from "./payloads";


/** Settings frame (host/host.ts / 1590 / 1628 / 1635 / 1641 / 2052; 1654 carries restartHint) */
export interface SettingsFrame {
  type: "settings";
  settings: SettingsPayload;
  restartHint?: boolean; // always true only in the set_desktop_env reply
}

/** Settings schema frame (host/host.ts get_settings_schema) */
export interface SettingsSchemaFrame {
  type: "settings_schema";
  // TODO(narrowing pass): SETTINGS_SCHEMA entry shape follows base config/settings (type/default/values etc.)
  schema: Record<string, unknown>;
}

export interface ModelsFrame {
  type: "models";
  models: ModelEntry[];
  roles: ModelRoleEntry[];
  defaultModel: string | null;
  defaultThinking: string | null;
  reqId?: number | null; // only carried by the reply wrapper of provider_login
}

/** Quick-switch result (host/rpc/models.ts cycle_model): ok=false = fewer than two resolvable roles, nothing to cycle */
export interface CycleModelFrame {
  type: "cycle_model";
  sessionId: string;
  ok: boolean;
  model?: string;
  role?: string;
  thinking?: string;
}

/** Models-management page catalog frame (host/host.ts and other send sites; the login flow carries reqId via a reply wrapper) */
export interface ModelsCatalogFrame {
  type: "models_catalog";
  models: ModelCatalogEntry[];
  reqId?: number | null; // only carried by the reply wrapper of provider_login
}

/** Provider list frame (host/host.ts get_all_providers) */
export interface AllProvidersFrame {
  type: "all_providers";
  providers: AllProviderEntry[];
}

/** Login progress frame (host/host.ts / 1710 onAuth / 1716 onProgress; the reply wrapper always carries reqId) */
export interface LoginProgressFrame {
  type: "login_progress";
  reqId: number | null;
  provider: string;
  message: string;
  url?: string; // onAuth variant only
}

/** Login paste-code prompt frame (host/host.ts onPrompt; the reply wrapper always carries reqId) */
export interface LoginPromptFrame {
  type: "login_prompt";
  reqId: number | null;
  provider: string;
  id: number; // promptSeq, echoed back as the key of login_prompt_reply
  message: string;
  secret: boolean;
}

/** Login done frame (host/host.ts success / 1742-1748 failure; the reply wrapper always carries reqId) */
export interface LoginDoneFrame {
  type: "login_done";
  reqId: number | null;
  provider: string;
  ok: boolean;
  identity?: unknown | null; // success only (base login identity object)
  cancelled?: boolean; // failure only
  message?: string; // failure only
}

/** API key configured frame (host/host.ts provider_set_key) */
export interface ProviderKeyDoneFrame {
  type: "provider_key_done";
  provider: string;
  ok: boolean; // always true
}

/** models.yml path frame (host/host.ts open_models_config) */
export interface ModelsConfigPathFrame {
  type: "models_config_path";
  path: string;
}

/** Catalog metadata the base would auto-inherit for an unedited wizard model (host/rpc/provider-wizard.ts) */
export interface ManualProbeCatalogMatch {
  name?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean;
  input?: ("text" | "image")[] | null; // accepted input modalities (null = unknown)
  supportsTools?: boolean | null; // native tool-call support (null = unknown)
  thinking?: { mode: string; efforts?: string[]; defaultLevel?: string } | null; // effort-control config
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

/** One model row from the wizard probe (endpoint-reported values + catalog match) */
export interface ManualProbeModel {
  id: string;
  name: string;
  contextWindow: number | null; // endpoint-reported, null when the endpoint did not say
  maxTokens: number | null;
  catalog: ManualProbeCatalogMatch | null; // null = no bundled-catalog match by id
  saved: ManualProbeCatalogMatch | null; // custom metadata already persisted in models.yml (null = bare/inherited row)
}

/** Wizard probe reply (host/rpc/provider-wizard.ts probe_provider_models) */
export interface ProviderModelsProbeFrame {
  type: "provider_models_probe";
  models: ManualProbeModel[];
  failed?: boolean;
  message?: string; // failure reason when failed
}

/** Wizard per-model save reply (host/rpc/provider-wizard.ts save_provider_model) */
export interface ProviderModelSavedFrame {
  type: "provider_model_saved";
  provider: string;
  model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}

/** One model row's metadata snapshot for a persisted provider (provider_model_meta reply) */
export interface ProviderModelMetaRow {
  id: string;
  saved: ManualProbeCatalogMatch | null;
  catalog: ManualProbeCatalogMatch | null;
}

/** Provider-detail metadata snapshot frame (host/rpc/provider-wizard.ts provider_model_meta) */
export interface ProviderModelMetaFrame {
  type: "provider_model_meta";
  provider: string;
  exists: boolean;
  models: ProviderModelMetaRow[];
}

/** Single-model connectivity test reply (host/rpc/models.ts test_provider_model) */
export interface ProviderModelTestFrame {
  type: "provider_model_test";
  model: string; // catalog id "provider/modelId"
  ok: boolean;
  latencyMs: number;
  reply?: string; // first 120 chars of the model's text answer (ok only)
  message?: string; // failure reason when !ok
}

/** Wizard save reply (host/rpc/provider-wizard.ts save_provider_models) */
export interface ProviderModelsSavedFrame {
  type: "provider_models_saved";
  provider: string;
  count: number;
}

/** Model roles frame (host/host.ts get_model_roles / 1861 set_model_role) */
export interface ModelRolesFrame {
  type: "model_roles";
  roles: ModelRoleEntry[];
}

/** Usage stats frame (host/host.ts get_usage_stats) */
export interface UsageStatsFrame {
  type: "usage_stats";
  stats: UsageStats;
}

/** Assets list frame (host/host.ts and other send sites) */
export interface AgentAssetsFrame {
  type: "agent_assets";
  assets: AgentAssetsPayload;
}

/** Extension-hub entry source metadata (host/extensions.ts ExtSource, a subset of base SourceMeta) */
export interface ExtSource {
  provider: string;
  providerName: string;
  level: "user" | "project" | "native";
}

/** Extension-hub entry detail precomputation (condition parsing / tool file header / command preview; sent by the host, rendered as-is) */
export interface ExtensionDetail {
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  agents?: string[];
  toolHeader?: string;
  body?: string;
  argumentHint?: string;
  usesArguments?: boolean;
}

/** Unified extension-hub entry (host/extensions.ts ExtensionItem; id follows the base disabledExtensions id scheme kind:name) */
export interface ExtensionItem {
  id: string;
  kind: string;
  name: string;
  displayName: string;
  description?: string;
  trigger?: string;
  path: string;
  source: ExtSource;
  state: "active" | "disabled" | "shadowed";
  disabledReason?: string;
  shadowedBy?: string;
  raw?: Record<string, unknown>;
  detail?: ExtensionDetail;
}

/** Extension-hub data frame (replies of four RPCs incl. host/host.ts list_extensions) */
export interface ExtensionsFrame {
  type: "extensions";
  scope: string; // profile | project:<cwd>
  scopes: { id: string; label: string }[];
  providers: {
    id: string;
    displayName: string;
    description: string;
    enabled: boolean;
    userSourceEnabled: boolean;
    foreignUserSource: boolean;
  }[];
  extensions: ExtensionItem[];
}

/** Asset file content reply (host/host.ts / 1928 / 1943 asset_file_read / asset_file_create) */
export interface AssetFileFrame {
  type: "asset_file";
  kind: AssetKind;
  path: string;
  content: string;
}

/** Editor/terminal/file-manager entry of the right-panel open-with menu (host/editors.ts) */
export interface EditorInfo {
  id: string;
  name: string;
  kind: "editor" | "terminal" | "fileManager";
  /** PNG data URL of the installed app's icon; absent when the icon cannot be resolved */
  iconDataUrl?: string;
}

/** Installed editors reply (host/rpc/settings.ts list_editors) */
export interface EditorsFrame {
  type: "editors";
  editors: EditorInfo[];
}

/** Asset file saved reply (host/host.ts asset_file_write) */
export interface AssetFileSavedFrame {
  type: "asset_file_saved";
  kind: AssetKind;
  path: string;
}

/** Asset file deleted reply (host/host.ts asset_skill_delete) */
export interface AssetFileDeletedFrame {
  type: "asset_file_deleted";
  kind: "skill"; // sender-side literal
  path: string;
}

/** Plugin install reply (host/rpc/assets.ts asset_plugin_install): `bun install` can
 * take minutes, so the UI needs an explicit terminal frame rather than inferring the
 * end from the follow-up agent_assets push. */
export interface PluginInstallResultFrame {
  type: "plugin_install_result";
  ok: boolean;
  name?: string;
  version?: string;
  error?: string;
}

/** Memory file reply (host/host.ts memory_file_read; files/rollouts are carried only by directory-style memories) */
export interface MemoryFileFrame {
  type: "memory_file";
  path: string;
  file: string; // basename of the file actually read
  files?: string[];
  rollouts?: string[];
  content: string;
}

/** MCP server test reply (host/rpc/assets.ts test_mcp_server) */
export interface McpServerTestedFrame {
  type: "mcp_server_tested";
  name: string;
  status: "ok" | "error";
  error?: string;
  log?: string;
}

/** Profile switched frame (host/host.ts switch_profile) */
export interface ProfileSwitchedFrame {
  type: "profile_switched";
  profile: string;
}

/** Body types of the capabilities snapshot (mirrors host/capabilities.ts CapabilitiesSnapshot) */
export interface CapabilitiesSnapshot {
  sessionId: string;
  mcp: { servers: { name: string; status: string }[]; tools: number };
  plugins: string[]; // plugin packages the session actually loaded
  extStatuses: [string, string][]; // extension-injected status badges (key → text), e.g. ponytail's setStatus
  lsp: { name: string; status: string; fileTypes?: string[]; error?: string }[];
  advisor: {
    configured: boolean;
    active: boolean;
    model?: string;
    contextWindow: number;
    contextTokens: number;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    messages: { user: number; assistant: number; total: number };
    advisors: { name: string; status: string; model?: string; cost: number; tokensTotal: number; messagesTotal: number }[];
  };
  memory: {
    backend: string;
    active: boolean;
    writable?: boolean;
    searchable?: boolean;
    scope?: string;
    workingCount?: number;
    episodicCount?: number;
    tripleCount?: number;
    lastMemory?: string;
    database?: string;
    message?: string;
    error?: string;
  };
  extensions: {
    loaded: boolean;
    paths: string[];
    tools: string[];
    commands: string[];
    diagnostics: { type: string; message: string; path: string }[];
  };
}

/** Capabilities snapshot reply (host/rpc/capabilities.ts get_capabilities; right-panel capabilities page) */
export interface CapabilitiesFrame {
  type: "capabilities";
  snapshot: CapabilitiesSnapshot;
}

/** MCP connection-status incremental push (host/session-lifecycle attachEntry; process-global, carries no sessionId) */
export interface CapabilitiesMcpFrame {
  type: "capabilities_mcp";
  mcp: { servers: { name: string; status: string }[]; tools: number };
}

/** Extension-injected status badge push (host/session-lifecycle uiCtx.setStatus; the capabilities card's plugin-status column) */
export interface ExtensionStatusFrame {
  type: "extension_status";
  sessionId: string;
  statuses: [string, string][]; // full replacement of the session's badge table
}


/** Terminal data frame (onData callback of host/host.ts terminal_create) */
export interface TerminalDataFrame {
  type: "terminal_data";
  id: string;
  data: string;
}

/** Terminal exit frame (host/host.ts onExit callback) */
export interface TerminalExitFrame {
  type: "terminal_exit";
  id: string;
  code: number;
}

/** Terminal created reply (host/host.ts terminal_create) */
export interface TerminalCreatedFrame {
  type: "terminal_created";
  id: string;
  shell: string;
}

/** One Agent browser tab in the mirror list (host/browser-mirror.ts MirrorTabInfo) */
export interface BrowserTabInfo {
  name: string;
  url: string;
  title: string;
  kind: string;
  /** Whether the backend supports a CDP screencast (cmux/tern surfaces do not) */
  mirrorable: boolean;
  /** Jsonl path of the session that created the tab; absent when unpooled/unowned — the UI filters the mirror to the displayed session by it */
  ownerPath?: string;
}

/** Agent browser tab-list push (host/browser-mirror.ts poll; stamped). Per-owner activation edges (auto-open) are derived here from consecutive snapshots. */
export interface BrowserTabsFrame {
  type: "browser_tabs";
  tabs: BrowserTabInfo[];
  hi?: string; // stamped frame
  seq?: number;
}

/** Agent browser screencast still (host/browser-mirror.ts Page.screencastFrame; unstamped, terminal-data style) */
export interface BrowserMirrorFrame {
  type: "browser_frame";
  name: string;
  data: string; // base64 jpeg
  ts: number;
  w?: number; // page viewport width in device px (screencast metadata)
  h?: number; // height, same unit
  s?: number; // page scale factor; CSS px = device px / s
}
