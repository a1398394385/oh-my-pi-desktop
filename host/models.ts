// Model catalog and settings snapshot: availableModels (full registry) ->
// scopedModels (enabledModels filter) -> modelsPayload/modelCatalog (two
// frontend views); settingsSnapshot is the get_settings payload.
import path from "node:path";
import fs from "node:fs";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { H, enabledDefaults } from "./state.ts";
import { getSupportedEfforts, getKnownRoleIds, getRoleInfo, formatModelRoleAlias, MODEL_ROLE_IDS, resolveModelRoleValue, authPolicyFor } from "./bootstrap.ts";
import { orderedSettings } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";

export function rebuildScopedModels() {
  const enabledEntries: string[] = settingsGet(H.settings, "enabledModels") ?? [];
  enabledDefaults.clear();
  for (const e of enabledEntries) enabledDefaults.set(e.split(":")[0], e.split(":")[1] ?? null);
  H.scopedModels =
    enabledDefaults.size > 0 ? H.availableModels.filter((m) => enabledDefaults.has(`${m.provider}/${m.id}`)) : H.availableModels;
}

/** Re-take both availability pools after a registry refresh: availableModels stays chat-only
 * (sessions, enable/disable scoping, composer menu); allModels adds every other kind including
 * keyless local runners, the pool the settings catalog and model-role assignment read — the same
 * surface as the base's roleCandidatePool (registry.getAvailable("all")). */
export function syncAvailableModels() {
  H.availableModels = H.modelRegistry.getAvailable();
  H.allModels = H.modelRegistry.getAvailable("all");
}

export function modelsPayload() {
  return H.scopedModels.map((m) => ({
    id: `${m.provider}/${m.id}`,
    name: m.name ?? m.id,
    efforts: getSupportedEfforts(m),
    // 18.5 capability axes read straight off the registry model: the
    // keepalive-relevant cache tier in seconds (long tier wins, short as
    // fallback — absent means unvalidated, never warmed), native or delegated
    // web-search grounding, native or delegated image generation
    ...(modelCapabilityAxes(m) ?? {}),
  }));
}

// Shared 18.5 capability-axis projection (undefined fields omitted so the
// frame shape stays backward-compatible for models without the axes)
function modelCapabilityAxes(m: {
  promptCache?: { short?: number; long?: number };
  webSearch?: unknown;
  webSearchModel?: unknown;
  hostedImage?: unknown;
  imageModel?: unknown;
}): { promptCache?: number; webSearch?: boolean; imageGen?: boolean } | undefined {
  const promptCache = m.promptCache ? (m.promptCache.long ?? m.promptCache.short) : undefined;
  const webSearch = !!(m.webSearch || m.webSearchModel);
  const imageGen = !!(m.hostedImage || m.imageModel);
  if (promptCache === undefined && !webSearch && !imageGen) return undefined;
  return {
    ...(promptCache !== undefined ? { promptCache } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(imageGen ? { imageGen } : {}),
  };
}

// Desktop has no TUI image protocol: the terminal.showImages condition is always false (when image protocol support arrives, change only this constant)
const HAS_IMAGE_PROTOCOL = false;

// Effective value per registered key: the layered read already falls back to
// the schema default when unconfigured
function computeValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const s of orderedSettings()) {
    values[s.id] = s.layered(H.settings);
  }
  return values;
}

// 12 condition functions implementing the semantics of the base settings-defs.ts CONDITIONS; each wrapped in try/catch returning false
function computeConditions(): Record<string, boolean> {
  const g = (k: string): unknown => {
    try {
      return settingsGet(H.settings, k);
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
    hideThinkingBlock: !!settingsGet(H.settings, "hideThinkingBlock"),
    computerEnabled: !!settingsGet(H.settings, "computer.enabled"),
    approvalMode: settingsGet(H.settings, "tools.approvalMode"),
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
  return H.allModels.map((m) => {
    const id = `${m.provider}/${m.id}`;
    const ctx = (m as any).contextWindow ?? (m as any).contextLength ?? null;
    const vision = Array.isArray((m as any).input) ? (m as any).input.includes("image") : !!(m as any).vision;
    return {
      id,
      name: m.name ?? m.id,
      provider: m.provider,
      // Catalog kind (chat/tiny/image/search/tts/stt/judge): the UI filters kind-role
      // candidate menus by it, mirroring the base's role accepts() pools
      kind: modelKind(m),
      enabled: allEnabled || enabled.has(id),
      context: ctx,
      vision,
      efforts: getSupportedEfforts(m),
      // Auth source: config = explicit apiKey in models.yml; cred = login/stored credential
      authSource: configSet.has(m.provider) ? "config" : "cred",
      ...(modelCapabilityAxes(m) ?? {}),
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
    defaultThinking: (settingsGet(H.settings, "defaultThinkingLevel") as string | undefined) ?? null,
  };
}

// Model role (@role) snapshot: 9 built-in roles first + custom roles present
// in settings.
// value = the raw explicit config from modelRoles (may be "provider/model",
// an "@smol" alias, or carry a ":level" suffix);
// resolved = the effectively active model resolved by expanding "@role"
// (unconfigured roles go through the built-in priority chain / role
// fallback);
// builtin = whether the id is one of the SDK's built-in roles (the composer
// model menu groups custom roles under its "Model Role" section).
export function modelRolesPayload() {
  return getKnownRoleIds(H.settings).map((role) => {
    const info = getRoleInfo(role, H.settings);
    const value = H.settings.getModelRole(role) ?? null;
    const { model } = resolveModelRoleValue(formatModelRoleAlias(role), H.allModels, { settings: H.settings });

    return {
      id: role,
      builtin: (MODEL_ROLE_IDS as readonly string[]).includes(role),
      section: info.section,
      name: info.name,
      tag: info.tag ?? null,
      value,
      resolved: model ? `${model.provider}/${model.id}` : null,
      resolvedName: (model?.name as string) ?? null,
    };
  });
}

// Auth ids consumed only by non-chat runners — the key-based web-search engines and the
// TypeSafe judge backend (mirrors the base's web/search/providers/* table + typesafe auth).
// They stay out of the add-provider grid (chat providers only) and surface on the settings
// capability page instead, where their API keys are managed.
export const CAPABILITY_AUTH_IDS = [
  "tavily",
  "exa",
  "kagi",
  "brave",
  "jina",
  "firecrawl",
  "tinyfish",
  "synthetic",
  "typesafe",
] as const;

const CAPABILITY_AUTH_LABELS: Record<string, string> = {
  tavily: "Tavily",
  exa: "Exa",
  kagi: "Kagi",
  brave: "Brave",
  jina: "Jina",
  firecrawl: "Firecrawl",
  tinyfish: "TinyFish",
  synthetic: "Synthetic",
  typesafe: "TypeSafe",
};

// Snapshot for the capability page: per engine, whether a key resolves now (stored credential
// or env alias) and whether a removable stored credential exists
export function capabilityKeysPayload() {
  return CAPABILITY_AUTH_IDS.map((id) => {
    const policy = authPolicyFor(id);
    return {
      id,
      label: CAPABILITY_AUTH_LABELS[id] ?? id,
      envVar: policy?.env?.vars?.[0] ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      configured: H.authStorage.keys.source(id, { env: "aliases" }) !== undefined,
      stored: H.authStorage.credentials.list(id).length > 0,
    };
  });
}
