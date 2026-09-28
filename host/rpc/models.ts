// 模型域 RPC：会话级切换（set_model/set_thinking）、启停（set_enabled_model）、
// 角色读写、目录快照与供应商清单。自 main.ts message 分发平移（第三刀）。
import { authPolicyFor } from "../bootstrap.ts";
import { H, sessions, enabledDefaults } from "../state.ts";
import { modelCatalog, modelRolesPayload, rebuildScopedModels } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import { listAllProviders } from "../limits/index.ts";
import { collectUsageStats } from "../stats.ts";
import type { RpcHandler } from "./types";

export const modelsHandlers: Record<string, RpcHandler> = {
  async set_model(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    process.stderr.write(`[host] set_model: ${msg.model} entry=${!!entry}\n`);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    const target = H.scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
    if (!target) throw new Error(`未知模型: ${msg.model}`);
    await entry.session.setModel(target); // persist 默认 false，仅本会话生效
    // enabledModels 条目带的 ":thinking" 默认级别与 CLI 行为一致地应用
    const defaultLevel = enabledDefaults.get(msg.model);
    if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
    const model = `${entry.session.model.provider}/${entry.session.model.id}`;
    // 模型切换后回传配置选择器（"auto" 或具体档位）：右下角显示用户配置的模式，
    // 能力钳制后的生效值属于发送参数细节，不进 UI
    ws.send(
      JSON.stringify({
        type: "session_model",
        sessionId: msg.sessionId,
        model,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      }),
    );
  },
  set_thinking(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    entry.session.setThinkingLevel(msg.level);
    // 回传配置选择器（"auto" 或具体档位）；钳制后的生效值不进 UI
    ws.send(
      JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.configuredThinkingLevel?.() ?? "auto" }),
    );
  },
  get_models_catalog(ws) {
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
  },
  async set_enabled_model(ws, msg) {
    const id = String(msg.id ?? "");
    const on = !!msg.enabled;
    if (!H.availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(`未知模型: ${id}`);
    let entries: string[] = (H.settings.get("enabledModels") ?? []).slice();
    if (entries.length === 0) {
      entries = H.availableModels.map((m) => `${m.provider}/${m.id}`);
    }
    const without = entries.filter((e) => e.split(":")[0] !== id);
    if (on) {
      const prev = entries.find((e) => e.split(":")[0] === id);
      without.push(prev ?? id);
    }
    if (without.length === 0) throw new Error("至少保留一个启用模型");
    H.settings.set("enabledModels", without);
    await H.settings.flush();
    rebuildScopedModels();
    if (H.scopedModels.length === 0) throw new Error("启用列表过滤后没有可用模型");
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
  },
  get_model_roles(ws) {
    ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
  },
  async set_model_role(ws, msg) {
    // 合法名即可写入：既改已知角色，也从输入框菜单创建自定义角色（覆盖同名旧值）
    const role = String(msg.role ?? "");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)) throw new Error(`非法角色名: ${role}`);
    // UI 只写精确 "provider/model"（或 null 清除回默认链），别名/后缀交给 settings.json 手写
    const value = msg.value == null || msg.value === "" ? undefined : String(msg.value);
    if (value && !H.availableModels.some((m) => `${m.provider}/${m.id}` === value)) {
      throw new Error(`未知模型: ${value}`);
    }
    H.settings.setModelRole(role, value);
    await H.settings.flush();
    ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
  },
  async get_usage_stats(ws) {
    ws.send(JSON.stringify({ type: "usage_stats", stats: await collectUsageStats() }));
  },
  get_all_providers(ws) {
    ws.send(
      JSON.stringify({
        type: "all_providers",
        providers: listAllProviders().map((p) => {
          let accounts = 0;
          try {
            accounts = (H.authStorage.listStoredCredentials?.(p.id) ?? []).length;
          } catch {}
          const loginKind = authPolicyFor(p.id)?.login?.kind;
          return {
            ...p,
            // 登录能力:仅 oauth-code/device-code/custom 有真实授权流(浏览器/设备码/供应商自定义);
            // api-key 型在底座只是「粘贴 key 并校验」,详情页已有 API Key 输入框,不再重复给入口
            login: loginKind === "oauth-code" || loginKind === "device-code" || loginKind === "custom",
            // 已配置账号数:authStorage 活跃凭证数(models.yml/env 层配置不计入)
            accounts,
          };
        }),
      }),
    );
  },
};
