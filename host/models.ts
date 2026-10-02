// Model catalog and settings snapshot: availableModels (full registry) ->
// scopedModels (enabledModels filter) -> modelsPayload/modelCatalog (two
// frontend views); settingsSnapshot is the get_settings payload.
import path from "node:path";
import fs from "node:fs";
import { H, enabledDefaults } from "./state.ts";
import { getSupportedEfforts, getKnownRoleIds, getRoleInfo, formatModelRoleAlias, resolveModelRoleValue } from "./bootstrap.ts";
import { SETTINGS_SCHEMA, getDefault } from "@oh-my-pi/pi-coding-agent/config/settings";

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

// Desktop has no TUI image protocol: the terminal.showImages condition is always false (when image protocol support arrives, change only this constant)
const HAS_IMAGE_PROTOCOL = false;

// Take the effective value per key, falling back to the schema default when unconfigured (503 pure in-memory reads, no I/O)
function computeValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const k of Object.keys(SETTINGS_SCHEMA)) {
    let v: unknown;
    try {
      v = H.settings.get(k);
    } catch {
      v = undefined;
    }
    if (v === undefined) {
      try {
        v = getDefault(k);
      } catch {
        v = undefined;
      }
    }
    values[k] = v;
  }
  return values;
}

// 12 condition functions implementing the semantics of the base settings-defs.ts CONDITIONS; each wrapped in try/catch returning false
function computeConditions(): Record<string, boolean> {
  const g = (k: string): unknown => {
    try {
      return H.settings.get(k);
    } catch {
      return undefined;
    }
  };
  const c: Record<string, boolean> = {};
  const safe = (name: string, fn: () => unknown): void => {
    try {
      c[name] = !!fn();
    } catch {
      c[name] = false;
    }
  };
  safe("macOS", () => process.platform === "darwin");
  safe("hasImageProtocol", () => HAS_IMAGE_PROTOCOL);
  safe("advisorEnabled", () => g("advisor.enabled") === true);
  safe("vimModeEnabled", () => g("tui.vimMode") === true);
  safe("hindsightActive", () => g("memory.backend") === "hindsight");
  safe("mnemopiActive", () => g("memory.backend") === "mnemopi");
  safe("autolearnActive", () => g("autolearn.enabled") === true);
  safe("autoThinkingActive", () => g("defaultThinkingLevel") === "auto");
  safe("usageAwareFallbackEnabled", () => g("retry.usageAwareFallback") === true);
  safe("planModeEnabled", () => g("plan.enabled"));
  safe("planAutosaveEnabled", () => g("plan.enabled") && g("plan.autosave"));
  safe("unexpectedStopSmart", () => g("features.unexpectedStopDetection") === "smart");
  return c;
}

export function settingsSnapshot() {
  return {
    hideThinkingBlock: !!H.settings.get("hideThinkingBlock"),
    computerEnabled: !!H.settings.get("computer.enabled"),
    approvalMode: H.settings.get("tools.approvalMode"),
    desktopEnv: H.desktopEnv,
    activeProfile: H.currentProfile,
    availableProfiles: H.cachedProfiles,
    profileAgentDir: H.agentDir,
    values: computeValues(),
    conditions: computeConditions(),
  };
}

// Scan the providers section of models.yml and return the ids of providers
// explicitly authenticating via apiKey. That key outranks stored credentials
// in getApiKey priority, so they count as the "config file" source; other
// available providers are the "login/API key credential" source. models.yml
// is hand-written, so scan by indentation instead of a full YAML parse.
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
    if (indent <= sectionIndent) break; // left the providers section
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
      // Auth source: config = explicit apiKey in models.yml; cred = login/stored credential
      authSource: configSet.has(m.provider) ? "config" : "cred",
    };
  });
}

// Config-file defaults for a new session: model = the default role's
// resolution (same as the base's actual choice when creating a new session),
// thinking level = the raw defaultThinkingLevel ("auto" or a concrete
// level). null when absent from the catalog.
export function modelsDefaults() {
  const { model } = resolveModelRoleValue(formatModelRoleAlias("default"), H.availableModels, { settings: H.settings });
  return {
    defaultModel: model ? `${model.provider}/${model.id}` : null,
    defaultThinking: (H.settings.get("defaultThinkingLevel") as string | undefined) ?? null,
  };
}

// Model role (@role) snapshot: 9 built-in roles first + custom roles present
// in settings.
// value = the raw explicit config from modelRoles (may be "provider/model",
// an "@smol" alias, or carry a ":level" suffix);
// resolved = the effectively active model resolved by expanding "@role"
// (unconfigured roles go through the built-in priority chain / role
// fallback).
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
