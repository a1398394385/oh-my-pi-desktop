// 限额查询适配层:把 token-monitor 移植的 vendor fetch(CJS)对接到 omp 的
// authStorage。omp provider id → vendor fetchXxxLimits 的 options 由本层按
// 凭证与 baseUrl 合成;结果按 omp provider 缓存 60s,避免 hover 反复打供应商。

import { createRequire } from "node:module";

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

const LIMITS_CACHE_TTL_MS = 60 * 1000;
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
export async function fetchSessionLimits(
  authStorage: KeyResolver,
  ompProvider: string,
  baseUrl: string
): Promise<{ vendor: string | null; label: string; row: LimitProviderRow | null }> {
  const spec = VENDOR_SPECS[ompProvider];
  if (!spec) return { vendor: null, label: ompProvider, row: null };

  const cached = limitsCache.get(ompProvider);
  if (cached && Date.now() - cached.at < LIMITS_CACHE_TTL_MS) {
    return { vendor: spec.vendor, label: spec.label, row: cached.row };
  }

  let row: LimitProviderRow;
  try {
    const key = await authStorage.getApiKey(ompProvider, undefined, { baseUrl });
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
  limitsCache.set(ompProvider, { at: Date.now(), row });
  return { vendor: spec.vendor, label: spec.label, row };
}

// 启动预载/定时刷新:对给定 omp provider 列表拉取全部配额(写入同一 60s 缓存,
// hover 的 get_limits 直接命中新鲜数据)。单供应商失败不影响其余。
export async function refreshAllLimits(
  authStorage: KeyResolver,
  providers: Array<{ id: string; baseUrl: string }>
): Promise<void> {
  await Promise.allSettled(providers.map((p) => fetchSessionLimits(authStorage, p.id, p.baseUrl)));
}

// 模型管理页「添加供应商」视图的数据源:全部受支持的 omp provider id 及展示标签
export function listAllProviders(): Array<{ id: string; label: string }> {
  return Object.entries(VENDOR_SPECS).map(([id, spec]) => ({ id, label: spec.label }));
}
