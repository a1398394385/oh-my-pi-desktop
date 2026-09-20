// 模型目录与设置快照：availableModels（注册表全量）→ scopedModels（enabledModels 过滤）
// → modelsPayload/modelCatalog（前端两种视图）；settingsSnapshot 是 get_settings 的 payload。
import path from "node:path";
import fs from "node:fs";
import { H, enabledDefaults } from "./state.ts";
import { getSupportedEfforts, getKnownRoleIds, getRoleInfo, formatModelRoleAlias, resolveModelRoleValue } from "./bootstrap.ts";

export function rebuildScopedModels() {
  const enabledEntries: string[] = H.settings.get("enabledModels") ?? [];
  enabledDefaults.clear();
  for (const e of enabledEntries) enabledDefaults.set(e.split(":")[0], e.split(":")[1] ?? null);
  H.scopedModels =
    enabledDefaults.size > 0 ? H.availableModels.filter((m) => enabledDefaults.has(`${m.provider}/${m.id}`)) : H.availableModels;
}

export function modelsPayload() {
  return H.scopedModels.map((m) => ({
    id: `${m.provider}/${m.id}`,
    name: m.name ?? m.id,
    efforts: getSupportedEfforts(m),
  }));
}

export function settingsSnapshot() {
  return {
    hideThinkingBlock: !!(H.settings as any).get("hideThinkingBlock"),
    sleepPrevention: H.settings.isConfigured("power.sleepPrevention") ? (H.settings.get("power.sleepPrevention") ?? "off") : "off",
    computerEnabled: !!H.settings.get("computer.enabled"),
    memoryBackend: H.settings.get("memory.backend") ?? "off",
    approvalMode: H.settings.get("tools.approvalMode"),
    askTimeout: typeof H.settings.get("ask.timeout") === "number" ? H.settings.get("ask.timeout") : 0,
    desktopEnv: H.desktopEnv,
    activeProfile: H.currentProfile,
    availableProfiles: H.cachedProfiles,
    profileAgentDir: H.agentDir,
  };
}

// 扫描 models.yml 的 providers 段,返回其中以 apiKey 显式配置认证的供应商 id。
// 该 key 在 getApiKey 优先级中高于存储凭证,因此视为「配置文件」来源;其余可用供应商
// 即「登录/API key 凭证」来源。models.yml 为手写配置,这里用缩进扫描而非完整 YAML 解析。
function configAuthProviders(): Set<string> {
  const result = new Set<string>();
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(H.agentDir, "models.yml"), "utf8");
  } catch {
    return result;
  }
  const lines = raw.split("\n");
  let inProviders = false;
  let sectionIndent = -1;
  let current: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inProviders) {
      if (/^providers\s*:\s*$/.test(trimmed)) {
        inProviders = true;
        sectionIndent = indent;
      }
      continue;
    }
    if (indent <= sectionIndent) break; // 离开 providers 段
    const entry = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*$/);
    if (entry && indent === sectionIndent + 2) {
      current = entry[1];
      continue;
    }
    if (current && /^apiKey\s*:/.test(trimmed)) result.add(current);
  }
  return result;
}

export function modelCatalog() {
  const enabled = new Set(enabledDefaults.keys());
  const allEnabled = enabled.size === 0;
  const configSet = configAuthProviders();
  return H.availableModels.map((m) => {
    const id = `${m.provider}/${m.id}`;
    const ctx = (m as any).contextWindow ?? (m as any).contextLength ?? null;
    const vision = Array.isArray((m as any).input) ? (m as any).input.includes("image") : !!(m as any).vision;
    return {
      id,
      name: m.name ?? m.id,
      provider: m.provider,
      enabled: allEnabled || enabled.has(id),
      context: ctx,
      vision,
      efforts: getSupportedEfforts(m),
      // 认证来源:config = models.yml 显式 apiKey;cred = 登录/存储凭证
      authSource: configSet.has(m.provider) ? "config" : "cred",
    };
  });
}

// 模型角色（@role）快照：内置 9 角色优先 + settings 里出现的自定义角色。
// value = modelRoles 里的显式配置原文（可能是 "provider/model"、"@smol" 别名或带 ":level" 后缀）；
// resolved = 以 "@role" 展开解析出的实际生效模型（未显式配置时走内置优先级链/角色回退）。
export function modelRolesPayload() {
  return getKnownRoleIds(H.settings).map((role) => {
    const info = getRoleInfo(role, H.settings);
    const value = H.settings.getModelRole(role) ?? null;
    const { model } = resolveModelRoleValue(formatModelRoleAlias(role), H.availableModels, { settings: H.settings });
    return {
      id: role,
      name: info.name,
      tag: info.tag ?? null,
      value,
      resolved: model ? `${model.provider}/${model.id}` : null,
      resolvedName: (model?.name as string) ?? null,
    };
  });
}
