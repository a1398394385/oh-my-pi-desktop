// 扩展中心域：omp CLI /extensions 控制中心的宿主侧实现。按 scope 统一发现能力条目
// （技能/规则/工具/扩展模块/MCP/提示/斜杠命令/钩子/上下文文件），清洗 raw 后下发 WS。
// scope 语义：profile = 用户级（当前 Profile，default 即 ~/.omp/agent）+ 原生内置；
// project:<cwd> = 该项目目录下的项目级条目。写路径与 TUI 对齐：项级开关 →
// disabledExtensions 设置数组（MCP 经 mcp.json 透写），供应商开关 → enabledProviders/
// disabledProviders（底座内部持久化）。SDK 引用一律经 bootstrap.ts（setProfile 必须先于
// coding-agent 加载，禁止静态 import 底座）。
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

// WS 下发条目的 source 元数据（同底座 SourceMeta 的可序列化子集）
export interface ExtSource {
  provider: string;
  providerName: string;
  level: "user" | "project" | "native";
}

// 单条目详情预计算（规则解析/工具文件头/命令预览），UI 直接渲染不再二次请求
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
  id: string; // kind:name（底座 disabledExtensions 的同一 id 方案）
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
  scope: string; // 本次数据的 scope id
  scopes: { id: string; label: string }[]; // 下拉可选项（profile + 各桌面项目）
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

// 下发字符串字段上限（context-file/prompt 正文可能很大）
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

// raw 清洗：JSON 往返丢弃函数（CustomTool factory 等），去掉 _ 前缀内部字段；
// MCP 条目 env/headers 可能存密钥，一律不下发。
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

// 按 kind 预计算详情区字段（与 TUI inspector-model 同一数据面）
function buildDetail(kind: string, ext: {
  path: string;
  description?: string;
  raw?: Record<string, unknown>;
}): ExtensionDetail | undefined {
  const raw = ext.raw;
  if (kind === "rule" && raw) {
    // raw 是 host 清洗后的底座 Rule 条目，parser 只读 frontmatter 字段（condition/scope 等）
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

// 聚合入口：list_extensions RPC 的数据帧。project:<cwd> 只看项目级条目，profile 看其余。
export async function buildExtensionsPayload(scope: unknown): Promise<ExtensionsPayload> {
  const scopeId = typeof scope === "string" && scope.startsWith("project:") ? scope : "profile";
  const cwd = scopeId.startsWith("project:") ? scopeId.slice("project:".length) : undefined;
  const disabledIds = (H.settings.get("disabledExtensions") ?? []) as string[];
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

// 项级开关：写 disabledExtensions（skill 同步清 skills.ignoredSkills，与 asset_skill_toggle 一致）；
// MCP 条目经 mcp.json 透写（/mcp disable 同路径），shadowed 条目拒绝。
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
  const disabled = new Set<string>((H.settings.get("disabledExtensions") ?? []) as string[]);
  if (on) disabled.delete(extId);
  else disabled.add(extId);
  H.settings.set("disabledExtensions", Array.from(disabled));
  if (kind === "skill") {
    const name = extId.slice(colon + 1);
    const ignored = new Set<string>((H.settings.get("skills.ignoredSkills") ?? []) as string[]);
    if (on) ignored.delete(name);
    H.settings.set("skills.ignoredSkills", Array.from(ignored));
  }
  await H.settings.flush();
}

// 供应商主开关（底座内部持久化 enabledProviders/disabledProviders）。返回切换后的状态。
export async function toggleExtensionProvider(providerId: unknown): Promise<boolean> {
  const id = String(providerId ?? "").trim();
  if (!id) throw new Error(hostI18n.t("errors.param.missingProviderId"));
  const enabled = toggleProvider(id);
  await H.settings.flush();
  return enabled;
}

// 外部工具 ~/ 配置 opt-in（持久化 enabledProviders 内的 user-source 项）。
export async function toggleExtensionUserSource(providerId: unknown): Promise<boolean> {
  const id = String(providerId ?? "").trim();
  if (!id) throw new Error(hostI18n.t("errors.param.missingProviderId"));
  const enabled = toggleUserSource(id);
  await H.settings.flush();
  return enabled;
}
