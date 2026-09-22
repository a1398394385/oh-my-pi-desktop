// 限额查询适配层:把 token-monitor 移植的 vendor fetch(CJS)对接到 omp 的
// authStorage。omp provider id → vendor fetchXxxLimits 的 options 由本层按
// 凭证与 baseUrl 合成;结果按 omp provider 缓存 60s,避免 hover 反复打供应商。

import { createRequire } from "node:module";
import { getOAuthProviders } from "../bootstrap.ts";

const require = createRequire(import.meta.url);
type VendorFetch = (options: Record<string, unknown>, deps: Record<string, unknown>) => Promise<LimitProviderRow | LimitProviderRow[]>;

// vendor 为 CJS、无类型声明,这里按统一 schema 声明其返回结构
interface LimitWindow {
  kind: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  resetDescription?: string;
}

interface LimitBalance {
  amount: number | null;
  currency?: string;
}

interface LimitProviderRow {
  provider: string;
  status: string;
  accountLabel?: string;
  planLabel?: string;
  windows: LimitWindow[];
  balance?: LimitBalance | null;
  updatedAt: string;
}

interface KeyResolver {
  getApiKey(provider: string, sessionId?: string, options?: { baseUrl?: string }): Promise<string | undefined>;
}

const { fetchKimiLimits } = require("./vendor/providers/kimi/limits.js") as { fetchKimiLimits: VendorFetch };
const { fetchZaiLimits } = require("./vendor/providers/zai/limits.js") as { fetchZaiLimits: VendorFetch };
const { fetchOpenRouterLimits } = require("./vendor/providers/openrouter/limits.js") as { fetchOpenRouterLimits: VendorFetch };
const { fetchDeepSeekLimits } = require("./vendor/providers/deepseek/limits.js") as { fetchDeepSeekLimits: VendorFetch };
const { fetchMinimaxLimits } = require("./vendor/providers/minimax/limits.js") as { fetchMinimaxLimits: VendorFetch };
const { fetchClaudeLimits } = require("./vendor/providers/claude/limits.js") as { fetchClaudeLimits: VendorFetch };
const { fetchAlibabaLimits } = require("./vendor/providers/alibaba/limits.js") as { fetchAlibabaLimits: VendorFetch };
const { fetchCommandcodeLimits } = require("./vendor/providers/commandcode/limits.js") as { fetchCommandcodeLimits: VendorFetch };
const { fetchOllamaLimits } = require("./vendor/providers/ollama/limits.js") as { fetchOllamaLimits: VendorFetch };
const { fetchCopilotLimits } = require("./vendor/providers/copilot/limits.js") as { fetchCopilotLimits: VendorFetch };
const { fetchGrokLimits } = require("./vendor/providers/grok/limits.js") as { fetchGrokLimits: VendorFetch };
const { fetchCodexLimits } = require("./vendor/providers/codex/limits.js") as { fetchCodexLimits: VendorFetch };
const { fetchAntigravityLimits } = require("./vendor/providers/antigravity/limits.js") as { fetchAntigravityLimits: VendorFetch };
const { fetchCursorLimits } = require("./vendor/providers/cursor/limits.js") as { fetchCursorLimits: VendorFetch };

// 缓存 TTL = 后台刷新周期(5min,host.ts LIMITS_REFRESH_INTERVAL_MS):后台定时全量重拉写缓存,
// 前台 hover/切页永远命中缓存,对供应商的实际请求频率严格等于后台节奏。
// 键统一 provider#凭证id(无凭证/非存储 key 回退 provider 裸键),三条查询路径共用同一份缓存。
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000;
const limitsCache = new Map<string, { at: number; row: LimitProviderRow }>();

// 供应商配置:omp provider id → vendor fetch + 标签。
// native = 无 authStorage 凭证也调用(vendor 自己从本机/环境发现凭据,
// 如 claude 读 ~/.claude、codex 读 ~/.codex、cursor 依赖 tokscale)。
interface VendorSpec {
  vendor: string;
  label: string;
  native: boolean;
  fetch: (key: string, baseUrl: string) => Promise<LimitProviderRow | LimitProviderRow[]>;
}

// baseUrl 判断 GLM 区域:bigmodel.cn = 国内站,其余走 z.ai 国际站
function zaiRegionForBaseUrl(baseUrl: string): string {
  return baseUrl.includes("bigmodel.cn") ? "bigmodel-cn" : "global";
}

const VENDOR_SPECS: Record<string, VendorSpec> = {
  "kimi-code": {
    vendor: "kimi",
    label: "Kimi",
    native: true,
    fetch: (key) => fetchKimiLimits({ kimiApiKey: key }, {})
  },
  moonshot: {
    vendor: "kimi",
    label: "Kimi",
    native: true,
    fetch: (key) => fetchKimiLimits({ kimiApiKey: key }, {})
  },
  zai: {
    vendor: "zai",
    label: "Z.ai (GLM)",
    native: true,
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  "zai-coding-plan": {
    vendor: "zai",
    label: "Z.ai (GLM)",
    native: true,
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  "zhipu-coding-plan": {
    vendor: "zai",
    label: "Z.ai (GLM)",
    native: true,
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  openrouter: {
    vendor: "openrouter",
    label: "OpenRouter",
    native: true,
    fetch: (key) => fetchOpenRouterLimits({ openrouterProfiles: { 默认: { apiKey: key } } }, {})
  },
  deepseek: {
    vendor: "deepseek",
    label: "DeepSeek",
    native: true,
    fetch: (key) => fetchDeepSeekLimits({ deepseekApiKey: key }, {})
  },
  minimax: { vendor: "minimax", label: "MiniMax", native: true, fetch: (key) => fetchMinimaxLimits({ minimaxApiKey: key }, {}) },
  "minimax-code": { vendor: "minimax", label: "MiniMax", native: true, fetch: (key) => fetchMinimaxLimits({ minimaxApiKey: key }, {}) },
  "minimax-code-cn": { vendor: "minimax", label: "MiniMax", native: true, fetch: (key) => fetchMinimaxLimits({ minimaxApiKey: key }, {}) },
  // claude:authStorage 的 anthropic OAuth token 经 CLAUDE_CODE_OAUTH_TOKEN 注入;
  // 无凭证时 vendor 自己发现 ~/.claude / macOS keychain
  anthropic: {
    vendor: "claude",
    label: "Claude",
    native: true,
    fetch: (key) => fetchClaudeLimits({}, key ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: key } } : {})
  },
  // codex/cursor:靠本机已登录的 CLI / IDE 状态(tokscale 扫描),不接 authStorage
  "openai-codex": { vendor: "codex", label: "OpenAI Codex", native: true, fetch: () => fetchCodexLimits({}, {}) },
  "openai-codex-device": { vendor: "codex", label: "OpenAI Codex", native: true, fetch: () => fetchCodexLimits({}, {}) },
  cursor: { vendor: "cursor", label: "Cursor", native: true, fetch: () => fetchCursorLimits({}, {}) },
  // antigravity:omp 的 Google OAuth token 组装成 vendor 的托管账户
  "google-antigravity": {
    vendor: "antigravity",
    label: "Google Antigravity",
    native: true,
    fetch: (key) =>
      fetchAntigravityLimits(
        { antigravityManagedAccounts: [{ id: "omp", accountEmail: "", credentials: { accessToken: key, expiresAt: Date.now() + 300_000 } }] },
        {}
      )
  },
  "github-copilot": {
    vendor: "copilot",
    label: "GitHub Copilot",
    native: true,
    fetch: (key) => fetchCopilotLimits({ copilotToken: key }, {})
  },
  xai: { vendor: "grok", label: "xAI (Grok)", native: true, fetch: (key) => fetchGrokLimits({ grokBearerToken: key }, {}) },
  "xai-oauth": { vendor: "grok", label: "xAI (Grok)", native: true, fetch: (key) => fetchGrokLimits({ grokBearerToken: key }, {}) },
  // cookie 型供应商:omp 凭证是 API key 形态接不上,靠环境变量 cookie 兜底
  "alibaba-coding-plan": { vendor: "alibaba", label: "Alibaba", native: true, fetch: () => fetchAlibabaLimits({}, {}) },
  "alibaba-token-plan": { vendor: "alibaba", label: "Alibaba", native: true, fetch: () => fetchAlibabaLimits({}, {}) },
  commandcode: { vendor: "commandcode", label: "Command Code", native: true, fetch: () => fetchCommandcodeLimits({}, {}) },
  "ollama-cloud": { vendor: "ollama", label: "Ollama", native: true, fetch: () => fetchOllamaLimits({}, {}) }
};

// 多账户 vendor 返回数组时取最优:有窗口的 ok 行优先,否则第一行
function pickRow(result: LimitProviderRow | LimitProviderRow[]): LimitProviderRow {
  const rows = Array.isArray(result) ? result : [result];
  return rows.find((r) => r.status === "ok" && r.windows.length > 0) ?? rows[0];
}

// 查会话当前供应商的限额。凭证经 authStorage.getApiKey 解析
// (支持 OAuth 自动续期与 env 兜底);native 供应商无凭证也尝试本机发现。
// keyOverride 显式传入时会话请求已解析好的 key(多账号 sticky 对齐),null 表示已解析但无凭证;
// cacheTag 是该 key 对应凭证的缓存键后缀(#id,与模型页 accounts/后台预载共用同一缓存行)。
export async function fetchSessionLimits(
  authStorage: KeyResolver,
  ompProvider: string,
  baseUrl: string,
  keyOverride?: string | null,
  cacheTag?: string
): Promise<{ vendor: string | null; label: string; row: LimitProviderRow | null }> {
  const spec = VENDOR_SPECS[ompProvider];
  if (!spec) return { vendor: null, label: ompProvider, row: null };

  const cacheKey = `${ompProvider}${cacheTag ?? ""}`;
  const cached = limitsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIMITS_CACHE_TTL_MS) {
    return { vendor: spec.vendor, label: spec.label, row: cached.row };
  }

  let row: LimitProviderRow;
  try {
    const key = keyOverride !== undefined ? (keyOverride ?? "") : await authStorage.getApiKey(ompProvider, undefined, { baseUrl });
    if (!key && !spec.native) {
      row = { provider: spec.vendor, status: "notConfigured", windows: [], updatedAt: new Date().toISOString() };
    } else {
      row = pickRow(await spec.fetch(key ?? "", baseUrl));
    }
  } catch (error) {
    // vendor fetch 抛出的错误带字符串 status(unauthorized/rateLimited/…)
    const status = error instanceof Error && "status" in error ? String(error.status) : "";
    row = {
      provider: spec.vendor,
      status: status && status !== "timeout" ? status : "unavailable",
      windows: [],
      updatedAt: new Date().toISOString()
    };
  }
  limitsCache.set(cacheKey, { at: Date.now(), row });
  return { vendor: spec.vendor, label: spec.label, row };
}

// 启动预载/定时刷新:对给定 omp provider 列表按账号逐凭证拉取配额,写入与
// 前台共用的一致键(provider#id;无凭证供应商回退 provider 裸键)。TTL=刷新周期,
// 后台刷新之间前台查询全部命中缓存。单供应商失败不影响其余。
export async function refreshAllLimits(
  authStorage: any,
  providers: Array<{ id: string; baseUrl: string }>
): Promise<void> {
  await Promise.allSettled(providers.map((p) => fetchProviderAccountsLimits(authStorage, p.id, p.baseUrl)));
}

// ---------- 多账号配额(一个供应商可登录多个账号,逐凭证拉配额) ----------

export interface AccountLimitRow {
  /** authStorage 凭证行 id(单凭证回退路径为 0) */
  id: number;
  /** 账号身份:email ?? accountId ?? orgName,api_key 凭证无身份为空串 */
  label: string;
  row: LimitProviderRow;
}

// 枚举供应商的全部未禁用凭证,逐个解析为可用 key 后拉配额:
// - api_key: key 直接可用
// - oauth: access token 可能过期,走官方 refreshCredentialById 刷新后取最新,失败回退存量 token
// 无凭证(单凭证 native 供应商本机发现 / listAuthCredentials 不可用)回退单行 fetchSessionLimits。
export async function fetchProviderAccountsLimits(
  authStorage: any,
  ompProvider: string,
  baseUrl: string
): Promise<{ vendor: string | null; label: string; accounts: AccountLimitRow[] }> {
  const spec = VENDOR_SPECS[ompProvider];
  if (!spec) return { vendor: null, label: ompProvider, accounts: [] };

  let creds: Array<{ id: number; credential: any }> = [];
  try {
    // 门面方法 listStoredCredentials 只返回活跃凭证(禁用墓碑留在 store 层)
    creds = (authStorage.listStoredCredentials(ompProvider) ?? []).map((c: any) => ({
      id: c.id,
      credential: c.credential,
    }));
  } catch {}
  if (!creds.length) {
    const { vendor, label, row } = await fetchSessionLimits(authStorage, ompProvider, baseUrl);
    return { vendor, label, accounts: row ? [{ id: 0, label: "", row }] : [] };
  }

  const accounts: AccountLimitRow[] = [];
  for (const { id, credential } of creds) {
    const cacheKey = `${ompProvider}#${id}`;
    const cached = limitsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LIMITS_CACHE_TTL_MS) {
      accounts.push({ id, label: credentialIdentity(credential), row: cached.row });
      continue;
    }
    let key = "";
    if (credential?.type === "api_key") {
      key = credential.key ?? "";
    } else if (credential?.type === "oauth") {
      try {
        const snap = await authStorage.refreshCredentialById(id);
        const c = snap?.credential;
        key = c?.type === "oauth" ? (c.access ?? "") : (c as any)?.key ?? "";
      } catch {
        key = credential.access ?? "";
      }
    }
    let row: LimitProviderRow;
    try {
      row = pickRow(await spec.fetch(key ?? "", baseUrl));
    } catch (error) {
      const status = error instanceof Error && "status" in error ? String(error.status) : "";
      row = {
        provider: spec.vendor,
        status: status && status !== "timeout" ? status : "unavailable",
        windows: [],
        updatedAt: new Date().toISOString(),
      };
    }
    limitsCache.set(cacheKey, { at: Date.now(), row });
    accounts.push({ id, label: credentialIdentity(credential), row });
  }
  return { vendor: spec.vendor, label: spec.label, accounts };
}

function credentialIdentity(credential: any): string {
  return credential?.email ?? credential?.accountId ?? credential?.orgName ?? "";
}

// 模型管理页「添加供应商」视图的数据源:与底座 TUI `/login` 同一份列表(getOAuthProviders),
// 外加底座无登录流但仍可配 API key 的供应商(VENDOR_SPECS 独有项,如 minimax)。
// 配额查询能力另由 VENDOR_SPECS 提供,未收录者配额段显示「暂不支持」。
export function listAllProviders(): Array<{ id: string; label: string }> {
  const rows = getOAuthProviders().map((p) => ({ id: p.id, label: p.name }));
  const seen = new Set(rows.map((r) => r.id));
  for (const [id, spec] of Object.entries(VENDOR_SPECS)) {
    if (!seen.has(id)) rows.push({ id, label: spec.label });
  }
  return rows;
}
