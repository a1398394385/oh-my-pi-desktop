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
  getDisabledProviders,
  setDisabledProviders,
  parseRuleConditionAndScope,
  parseRuleAgents,
  toolFileHeaderDescription,
  commandPreview,
  setMcpServerEnabled,
  clearCapabilityFsCache,
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

// Context-file shadowing key mirroring the base capability dedupe key:
// scope-only — "user" or "project:<depth>" — ignoring the basename, because
// the base keys context files per scope, not per file name. Reads level/depth
// off the raw (unsanitized) ContextFile via type guards; returns a stable
// fallback when the raw shape is missing.
function ctxFileShadowKey(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && "level" in raw) {
    const level: unknown = raw.level;
    if (level === "user") return "context-file:user";
    const depth: unknown = "depth" in raw ? raw.depth : 0;
    return `context-file:project:${Math.max(0, typeof depth === "number" ? depth : 0)}`;
  }
  return "context-file:unknown";
}

// Aggregate entry: the data frame of the list_extensions RPC. project:<cwd> sees only project-level entries; profile sees the rest.
export async function buildExtensionsPayload(scope: unknown): Promise<ExtensionsPayload> {
  const scopeId = typeof scope === "string" && scope.startsWith("project:") ? scope : "profile";
  const cwd = scopeId.startsWith("project:") ? scopeId.slice("project:".length) : undefined;
  const disabledIds = (settingsGet(H.settings, "disabledExtensions") ?? []) as string[];
  // This page is the explicit "I just edited config files on disk" refresh, so
  // discovery must cold-read. The capability fs cache (contentCache/dirCache,
  // keyed by absolute path) is process-lifetime and nothing else clears it for
  // context-files, so a file the user just created/edited/filled in (e.g. a
  // previously empty ~/.agents/AGENTS.md) would keep its first-read verdict —
  // including the cached "empty -> null" that keeps it out of this page —
  // until the host restarts. Mirrors invalidateSshCaches() in host/rpc/ssh.ts.
  clearCapabilityFsCache();
  // Temporarily bypass disabledProviders filter during extension discovery so disabled
  // providers' entries are always discovered and rendered, rather than disappearing when disabled.
  const savedDisabledProviders = getDisabledProviders();
  let all: Awaited<ReturnType<typeof loadAllExtensions>>;
  try {
    if (savedDisabledProviders.length > 0) {
      setDisabledProviders([]);
    }
    all = await loadAllExtensions(cwd, disabledIds);
  } finally {
    if (savedDisabledProviders.length > 0) {
      setDisabledProviders(savedDisabledProviders);
    }
  }

  const disabledProvSet = new Set(savedDisabledProviders);
  const extensions: ExtensionItem[] = [];

  // Re-resolve shadowing against the *effective* provider state (post-restore).
  // Discovery ran with disabledProviders bypassed so disabled sources' entries
  // still render — but that also let those entries claim dedupe keys and shadow
  // same-name entries from enabled lower-priority sources, producing
  // "shadowed by a disabled source" rows that contradict runtime (disabled
  // sources never load). Re-run the same first-wins dedupe over entries that
  // actually load: enabled provider, not item-disabled, not an opt-out foreign
  // user source (mirrors base resolveState gates; the claude-plugins
  // omp-native-root exemption reads origin off raw._source, which sanitizeRaw
  // never touches on the local objects).
  const winnerMap = new Map<string, (typeof all)[0]>();
  for (const ext of all) {
    if (disabledProvSet.has(ext.source.provider)) continue;
    if (ext.disabledReason === "item-disabled") continue;
    const origin = (ext.raw as { _source?: { origin?: string } } | undefined)?._source?.origin;
    const nativeMarketplaceRoot = ext.source.provider === "claude-plugins" && origin !== undefined && origin !== "claude";
    if (!nativeMarketplaceRoot && ext.source.level === "user" && !isUserSourceEnabled(ext.source.provider)) continue;
    // Shadowing key must mirror the base capability dedupe key exactly.
    // Most kinds are name-keyed, where the extension id (`kind:name`) already
    // matches. Context files are the exception: the base key is scope-only —
    // "user", or "project:<depth>" — ignoring the basename, so monorepo
    // same-named files at different depths coexist, while same-scope files
    // (e.g. AGENTS.md + CLAUDE.md in one directory) mutually shadow. The id
    // (level + basename) matches neither dimension, so derive the key from
    // the raw ContextFile's level/depth instead.
    const key = ext.kind === "context-file" ? ctxFileShadowKey(ext.raw) : ext.id;
    if (!winnerMap.has(key)) winnerMap.set(key, ext);
  }

  for (const ext of all) {
    const isProject = ext.source.level === "project";
    if (cwd ? !isProject : isProject) continue;
    const raw = sanitizeRaw(ext.kind, ext.raw);
    const winner = winnerMap.get(ext.kind === "context-file" ? ctxFileShadowKey(ext.raw) : ext.id);
    let state = ext.state;
    let disabledReason = ext.disabledReason;
    let shadowedBy = ext.shadowedBy;
    if (disabledProvSet.has(ext.source.provider)) {
      state = "disabled";
      disabledReason = "provider-disabled";
    } else if (winner && winner !== ext && ext.state !== "disabled") {
      // A same-name entry that loads at runtime wins: shadowed, and
      // shadowedBy points at the live winner (not a bypassed claimant)
      state = "shadowed";
      disabledReason = "shadowed";
      const winnerProv = winner.source?.providerName || winner.source?.provider || "";
      shadowedBy = `${winnerProv} · ${winner.displayName || winner.name}`;
    } else if (ext.state === "shadowed") {
      // Shadowed only under the bypass window (the claimant was from a
      // disabled source, an item-disabled row, or an opt-out user source):
      // this entry is the live one
      state = "active";
      disabledReason = undefined;
      shadowedBy = undefined;
    }
    extensions.push({
      id: ext.id,
      kind: ext.kind,
      name: ext.name,
      displayName: ext.displayName,
      description: ext.description,
      trigger: ext.trigger,
      path: ext.path,
      source: ext.source,
      state,
      disabledReason,
      shadowedBy,
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
