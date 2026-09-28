// 全帧组装层：models/settings 两帧被多个 rpc 域与 main 的 ready 帧共用。
// 独立成层的原因：settingsFrame 组合 models.ts 的快照与 profile/assets 的开关读取，
// 下沉任一侧都会成环（profile→models 已有边）——注释沿自 main.ts 原文「不下沉 models.ts，避免模块环」。
import { H } from "./state.ts";
import { modelsPayload, modelsDefaults, settingsSnapshot } from "./models.ts";
import { readAcpConfig, readAcpEnabled, readSessionContextEnabled } from "./profile.ts";
import { readKeepaliveEnabled, readKeepaliveProbeConfig } from "./keepalive-config.ts";
import { readHooksEnabled, readPluginsEnabled } from "./assets.ts";

// models 帧统一组装：目录 + 新建会话配置默认（defaultModel/defaultThinking），
// 所有发送点共用，避免漏带默认字段
export function modelsFrame() {
  return { type: "models", models: modelsPayload(), ...modelsDefaults() };
}

/** 设置帧 = 底座设置快照 + host 侧实验开关。 */
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
