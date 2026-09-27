// 设置中心 slice：开合/当前页、宿主设置与 schema、模型目录与角色、供应商管理视图、
// 登录流程状态、资产编辑器（skills/agents/mcp/memory）回包落地。自 store.ts 平移（P3 波 2）。
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
  settingsOpen: boolean; // 全屏 overlay 开合
  settingsPage: string; // 当前设置页 id
  hostSettings: SettingsPayload | null;
  settingsSchema: Record<string, SchemaDef> | null; // 条目形状同 SETTINGS_SCHEMA
  modelCatalog: ModelCatalogEntry[];
  modelRoles: ModelRoleEntry[] | null;
  selectedProvider: string | null;
  mpAddView: boolean;
  mpRolesView: boolean;
  mpDetailProv: AllProviderEntry | null; // 供应商详情页当前供应商(卡片点击写入)
  allProvidersCache: AllProviderEntry[] | null;
  loginBusy: boolean;
  loginReqId: number;
  loginBanner: string | null; // OMP 登录进度横幅文本
  loginPromptData: LoginPromptFrame | null; // login_prompt 粘贴码弹窗数据
  agentAssets: AgentAssetsPayload | null;
  extensions: ExtensionsFrame | null; // 扩展中心数据帧（list_extensions / toggle_* 回包）
  extensionsByScope: Record<string, ExtensionsFrame>; // 同上但按 scope 累积（资产页来源徽标跨 scope 匹配用）
  usageStats: UsageStats | null;
  providerLimits: ProviderLimitsResultFrame | null; // provider_limits_result 配额帧
  assetFile: AssetFileFrame | null; // asset_file 回包(skills/agents 编辑器按 kind 过滤)
  assetFileSaved: { kind: string; at: number } | null; // asset_file_saved 落地(引用变化驱动「已保存」态)
  assetSaved: { kind: string; at: number } | null; // 同上,agents 页消费
  assetErr: { kind: string; message: string; at: number } | null; // error 帧带 kind 时落地
  mcpTestResults: Record<string, { status: string; error?: string; log?: string; ts: number }>; // MCP 单服务器测试结果
  memoryDetail: MemoryDetailState; // memory_file 帧落地
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
  // 打开设置中心时的四连数据请求（旧版 refreshSettingsData 平移；send 在未连接时静默丢弃，
  // 连接就绪由 connect 的 onopen 补拉）
  refreshSettingsData() {
    if (!get().settingsSchema) get().send({ type: "get_settings_schema" });
    get().send({ type: "get_settings" });
    get().send({ type: "get_models_catalog" });
    get().send({ type: "list_agent_assets" });
    get().send({ type: "get_usage_stats" });
  },
});
