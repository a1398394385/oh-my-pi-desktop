// Extensions center domain: host-side implementation of the omp CLI
// /extensions control center. Discovers capability entries (skills/rules/
// tools/extension modules/MCP/prompts/slash commands/hooks/context files)
// uniformly by scope, sanitizes raw, and ships them over WS.
// Scope semantics: profile = user level (current profile; default is
// ~/.omp/agent) + native built-ins; project:<cwd> = project-level entries
// under that project directory. Write paths align with the TUI: per-item
// switches -> the disabledExtensions settings array (MCP goes through
// mcp.json passthrough), provider switches -> enabledProviders/
// disabledProviders (persisted inside the base). SDK references always go
// through bootstrap.ts (setProfile must run before coding-agent loads;
// static imports of the base are forbidden).
import path from "node:path";
import { H } from "./state.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";
import {
  loadAllExtensions,
  toggleProvider,
  toggleUserSource,
  getAllProvidersInfo,
  isUserSourceEnabled,
  isForeignUserProvider,
  parseRuleConditionAndScope,
  parseRuleAgents,
  toolFileHeaderDescription,
  commandPreview,
  setMcpServerEnabled,
} from "./bootstrap.ts";
import { settingsGet, settingsSet } from "./settings-compat.ts";

// Source metadata of WS-shipped entries (a serializable subset of the base SourceMeta)
export interface ExtSource {
  provider: string;
  providerName: string;
  level: "user" | "project" | "native";
}

// Per-entry detail precompute (rule parsing/tool file header/command preview) so the UI renders directly without a second request
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

export interface ExtensionItem {
  id: string; // kind:name (same id scheme as the base disabledExtensions)
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

export interface ExtensionsPayload {
  scope: string; // scope id of this payload
  scopes: { id: string; label: string }[]; // dropdown options (profile + each desktop project)
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

// Cap on shipped string fields (context-file/prompt bodies can be huge)
const MAX_FIELD = 50_000;

function cap(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_FIELD) return value.slice(0, MAX_FIELD) + "…";
  if (Array.isArray(value)) return value.map(cap);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cap(v);
    return out;
  }
  return value;
}

// raw sanitization: a JSON round-trip drops functions (CustomTool factories
// etc.) and _-prefixed internal fields are removed;
// MCP entries' env/headers may hold secrets — never shipped.
function sanitizeRaw(kind: string, raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const key of Object.keys(rec)) {
    if (key.startsWith("_")) delete rec[key];
  }
  if (kind === "mcp") {
    delete rec.env;
    delete rec.headers;
  }
  return cap(rec) as Record<string, unknown>;
}

// Precompute detail fields by kind (same data face as the TUI inspector-model)
function buildDetail(kind: string, ext: {
  path: string;
  description?: string;
  raw?: Record<string, unknown>;
}): ExtensionDetail | undefined {
  const raw = ext.raw;
  if (kind === "rule" && raw) {
    // raw is a host-sanitized base Rule entry; the parser only reads frontmatter fields (condition/scope etc.)
    const frontmatter = raw as unknown as Parameters<typeof parseRuleConditionAndScope>[0];
    const parsed = parseRuleConditionAndScope(frontmatter);
    const agents = parseRuleAgents(raw.agents);
    const detail: ExtensionDetail = {};
    if (parsed.condition) detail.condition = parsed.condition;
    if (parsed.astCondition) detail.astCondition = parsed.astCondition;
    if (parsed.scope) detail.scope = parsed.scope;
    if (agents) detail.agents = agents;
    return Object.keys(detail).length ? detail : undefined;
  }
  if (kind === "tool") {
    const toolHeader = toolFileHeaderDescription(ext.path);
    return toolHeader ? { toolHeader } : undefined;
  }
  if (kind === "slash-command") {
    const preview = commandPreview(typeof raw?.content === "string" ? raw.content : undefined);
    const detail: ExtensionDetail = { body: preview.body, usesArguments: preview.usesArguments };
    if (preview.argumentHint) detail.argumentHint = preview.argumentHint;
    return detail;
  }
  return undefined;
}

// Aggregate entry: the data frame of the list_extensions RPC. project:<cwd> sees only project-level entries; profile sees the rest.
export async function buildExtensionsPayload(scope: unknown): Promise<ExtensionsPayload> {
  const scopeId = typeof scope === "string" && scope.startsWith("project:") ? scope : "profile";
  const cwd = scopeId.startsWith("project:") ? scopeId.slice("project:".length) : undefined;
  const disabledIds = (settingsGet(H.settings, "disabledExtensions") ?? []) as string[];
  const all = await loadAllExtensions(cwd, disabledIds);
  const extensions: ExtensionItem[] = [];
  for (const ext of all) {
    const isProject = ext.source.level === "project";
    if (cwd ? !isProject : isProject) continue;
    const raw = sanitizeRaw(ext.kind, ext.raw);
    extensions.push({
      id: ext.id,
      kind: ext.kind,
      name: ext.name,
      displayName: ext.displayName,
      description: ext.description,
      trigger: ext.trigger,
      path: ext.path,
      source: ext.source,
      state: ext.state,
      disabledReason: ext.disabledReason,
      shadowedBy: ext.shadowedBy,
      raw,
      detail: buildDetail(ext.kind, { path: ext.path, description: ext.description, raw }),
    });
  }
  const scopes: ExtensionsPayload["scopes"] = [
    { id: "profile", label: `Profile · ${H.currentProfile || "default"}` },
  ];
  for (const p of H.desktopProjects.allProjects) {
    scopes.push({ id: `project:${p}`, label: hostI18n.t("flows.extProjectScope", { name: path.basename(p) }) });
  }
  const providers = getAllProvidersInfo().map((p) => ({
    ...p,
    userSourceEnabled: isUserSourceEnabled(p.id),
    foreignUserSource: isForeignUserProvider(p.id),
  }));
  return { scope: scopeId, scopes, providers, extensions };
}

// Per-item switch: writes disabledExtensions (skill also clears
// skills.ignoredSkills in sync, matching asset_skill_toggle);
// MCP entries go through mcp.json passthrough (same path as /mcp disable);
// shadowed entries are rejected.
export async function toggleExtensionItem(id: unknown, enabled: unknown, sourcePath?: unknown): Promise<void> {
  const extId = String(id ?? "");
  const colon = extId.indexOf(":");
  if (colon <= 0) throw new Error(hostI18n.t("errors.extension.invalidId", { id: extId }));
  const kind = extId.slice(0, colon);
  const on = Boolean(enabled);
  if (kind === "mcp") {
    const name = extId.slice(colon + 1);
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    await setMcpServerEnabled({
      userPath: path.join(H.agentDir, "mcp.json"),
      projectPath: typeof sourcePath === "string" && sourcePath ? sourcePath : path.join(H.agentDir, "mcp.json"),
      sourcePath: typeof sourcePath === "string" && sourcePath ? sourcePath : undefined,
      name,
      enabled: on,
    });
    return;
  }
  const disabled = new Set<string>((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]);
  if (on) disabled.delete(extId);
  else disabled.add(extId);
  settingsSet(H.settings, "disabledExtensions", Array.from(disabled));
  if (kind === "skill") {
    const name = extId.slice(colon + 1);
    const ignored = new Set<string>((settingsGet(H.settings, "skills.ignoredSkills") ?? []) as string[]);
    if (on) ignored.delete(name);
    settingsSet(H.settings, "skills.ignoredSkills", Array.from(ignored));
  }
  await H.settings.flush();
}

// Provider master switch (persists enabledProviders/disabledProviders inside the base). Returns the post-toggle state.
export async function toggleExtensionProvider(providerId: unknown): Promise<boolean> {
  const id = String(providerId ?? "").trim();
  if (!id) throw new Error(hostI18n.t("errors.param.missingProviderId"));
  const enabled = toggleProvider(id);
  await H.settings.flush();
  return enabled;
}

// External tools ~/ config opt-in (persists the user-source entries inside enabledProviders).
export async function toggleExtensionUserSource(providerId: unknown): Promise<boolean> {
  const id = String(providerId ?? "").trim();
  if (!id) throw new Error(hostI18n.t("errors.param.missingProviderId"));
  const enabled = toggleUserSource(id);
  await H.settings.flush();
  return enabled;
}
