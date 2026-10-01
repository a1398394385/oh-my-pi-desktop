// 启动与配置域帧：ready 握手、模型目录、设置快照/schema、profile 切换、
// 审批模式、用量统计、资产清单、扩展清单。自 store/ws.ts onMessage 平移。
import { useAppStore } from "../index";
import { hostInstanceReset, ingestModelDefaults, ingestModels } from "../session";
import { t } from "../../i18n";
import type { ApprovalMode } from "../../types/frames";
import type { SchemaDef } from "../../components/settings/placement";
import type { HandlerSlice } from "./types";

export const configHandlers = {
  ready(msg) {
    // 握手帧不占 seq：仅在实例变化时重置；重连（同 hi）保留已见位置避免假跳号
    const st = useAppStore.getState();
    if (msg.hi && st.evtHost !== msg.hi) hostInstanceReset(msg.hi, 0);
    // approvalMode 在宿主侧为未收窄字符串(SettingsSnapshot.approvalMode 同),三值校验在宿主
    const approvalMode = (msg.approvalMode as ApprovalMode | undefined) ?? st.approvalMode;
    ingestModels(msg.models);
    useAppStore.setState({ approvalMode });
    // 启动即进欢迎页时 ready 帧晚于首次 initNewSessionModel：配置默认到位后立即重校准
    if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
      useAppStore.getState().initNewSessionModel(true);
    }
    if (msg.settings) {
      // 字段级白名单合并：host 设置帧只有 hideThinkingBlock 影响本地外观偏好
      if (typeof msg.settings.hideThinkingBlock === "boolean") {
        useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
      }
      useAppStore.setState({ hostSettings: msg.settings });
    }
  },
  models(msg) {
    ingestModels(msg.models);
    if (ingestModelDefaults(msg) && useAppStore.getState().isCreatingNew && !useAppStore.getState().newSessionDirty) {
      useAppStore.getState().initNewSessionModel(true);
    }
  },
  models_catalog(msg) {
    useAppStore.setState((s) => ({ modelCatalog: msg.models ?? [] }));
  },
  model_roles(msg) {
    useAppStore.setState((s) => ({ modelRoles: msg.roles ?? [] }));
  },
  settings(msg) {
    if (typeof msg.settings?.hideThinkingBlock === "boolean") {
      useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking: !msg.settings.hideThinkingBlock } }));
    }
    useAppStore.setState({ hostSettings: msg.settings });
    if (msg.restartHint) useAppStore.getState().toast(t("notify.savedRestartHint"));
  },
  settings_schema(msg) {
    // 宿主 schema 条目即 SETTINGS_SCHEMA 形状(与 SchemaDef 对齐),帧侧暂为粗形,边界处收窄
    useAppStore.setState((s) => ({ settingsSchema: msg.schema as Record<string, SchemaDef> }));
  },
  profile_switched(msg) {
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
    useAppStore.setState((s) => ({ agentAssets: msg.assets }));
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
} satisfies HandlerSlice;

// 域键集（供 index 的穷尽断言交叉验证）
export type ConfigFrames = keyof typeof configHandlers;
