// Limits query adapter layer: wires the token-monitor ported vendor fetch
// (CJS) onto omp's authStorage. The options for omp provider id -> vendor
// fetchXxxLimits are synthesized here from the credential and baseUrl; results
// are cached 5min per omp provider/credential (TTL = the background refresh
// cadence in main.ts) so foreground queries never hit vendors directly.

import type { AuthCredential, AuthStorage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "../bootstrap.ts";
// vendor is CJS; static imports get bundled (bun build --compile does not
// track createRequire dynamic requires, which would be missed and cause
// Cannot find module at runtime in the packaged build)
import { fetchKimiLimits as _fetchKimiLimits } from "./vendor/providers/kimi/limits.js";
import { fetchZaiLimits as _fetchZaiLimits } from "./vendor/providers/zai/limits.js";
import { fetchOpenRouterLimits as _fetchOpenRouterLimits } from "./vendor/providers/openrouter/limits.js";
import { fetchDeepSeekLimits as _fetchDeepSeekLimits } from "./vendor/providers/deepseek/limits.js";
import { fetchMinimaxLimits as _fetchMinimaxLimits } from "./vendor/providers/minimax/limits.js";
import { fetchClaudeLimits as _fetchClaudeLimits } from "./vendor/providers/claude/limits.js";
import { fetchAlibabaLimits as _fetchAlibabaLimits } from "./vendor/providers/alibaba/limits.js";
import { fetchCommandcodeLimits as _fetchCommandcodeLimits } from "./vendor/providers/commandcode/limits.js";
import { fetchOllamaLimits as _fetchOllamaLimits } from "./vendor/providers/ollama/limits.js";
import { fetchCopilotLimits as _fetchCopilotLimits } from "./vendor/providers/copilot/limits.js";
import { fetchGrokLimits as _fetchGrokLimits } from "./vendor/providers/grok/limits.js";
import { fetchCodexLimits as _fetchCodexLimits } from "./vendor/providers/codex/limits.js";
import { fetchAntigravityLimits as _fetchAntigravityLimits } from "./vendor/providers/antigravity/limits.js";
import { fetchCursorLimits as _fetchCursorLimits } from "./vendor/providers/cursor/limits.js";
import { fetchClineLimits as _fetchClineLimits } from "./vendor/providers/cline/limits.js";
import { fetchDevinLimits as _fetchDevinLimits } from "./vendor/providers/devin/limits.js";
import { fetchFactoryLimits as _fetchFactoryLimits } from "./vendor/providers/factory/limits.js";
import { fetchMimoLimits as _fetchMimoLimits } from "./vendor/providers/mimo/limits.js";
import { fetchOpenCodeLimits as _fetchOpenCodeLimits } from "./vendor/providers/opencode/limits.js";
import { fetchStepfunLimits as _fetchStepfunLimits } from "./vendor/providers/stepfun/limits.js";
import { fetchTypesafeLimits as _fetchTypesafeLimits } from "./vendor/providers/typesafe/limits.js";

type VendorFetch = (options: Record<string, unknown>, deps: Record<string, unknown>) => Promise<LimitProviderRow | LimitProviderRow[]>;

// vendor is CJS with no type declarations; declare its return shape here against a unified schema
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

const fetchKimiLimits = _fetchKimiLimits as unknown as VendorFetch;
const fetchZaiLimits = _fetchZaiLimits as unknown as VendorFetch;
const fetchOpenRouterLimits = _fetchOpenRouterLimits as unknown as VendorFetch;
const fetchDeepSeekLimits = _fetchDeepSeekLimits as unknown as VendorFetch;
const fetchMinimaxLimits = _fetchMinimaxLimits as unknown as VendorFetch;
const fetchClaudeLimits = _fetchClaudeLimits as unknown as VendorFetch;
const fetchAlibabaLimits = _fetchAlibabaLimits as unknown as VendorFetch;
const fetchCommandcodeLimits = _fetchCommandcodeLimits as unknown as VendorFetch;
const fetchOllamaLimits = _fetchOllamaLimits as unknown as VendorFetch;
const fetchCopilotLimits = _fetchCopilotLimits as unknown as VendorFetch;
const fetchGrokLimits = _fetchGrokLimits as unknown as VendorFetch;
const fetchCodexLimits = _fetchCodexLimits as unknown as VendorFetch;
const fetchAntigravityLimits = _fetchAntigravityLimits as unknown as VendorFetch;
const fetchCursorLimits = _fetchCursorLimits as unknown as VendorFetch;
const fetchClineLimits = _fetchClineLimits as unknown as VendorFetch;
const fetchDevinLimits = _fetchDevinLimits as unknown as VendorFetch;
const fetchFactoryLimits = _fetchFactoryLimits as unknown as VendorFetch;
const fetchMimoLimits = _fetchMimoLimits as unknown as VendorFetch;
const fetchOpenCodeLimits = _fetchOpenCodeLimits as unknown as VendorFetch;
const fetchStepfunLimits = _fetchStepfunLimits as unknown as VendorFetch;
const fetchTypesafeLimits = _fetchTypesafeLimits as unknown as VendorFetch;

// Cache TTL = background refresh interval (5min, host.ts
// LIMITS_REFRESH_INTERVAL_MS): the background timer re-pulls everything and
// writes the cache, foreground hover/page-switch always hits cache, so the
// real request rate to vendors strictly equals the background cadence.
// Keys are uniformly provider#credentialId (no credential / non-stored key
// falls back to the bare provider key); all three query paths share one cache.
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000;
const limitsCache = new Map<string, { at: number; row: LimitProviderRow }>();

// Vendor specs: omp provider id -> vendor fetch + label.
// A vendor is only ever called with a credential resolved from authStorage:
// quotas are never derived from another tool's local sign-in state, so a
// provider without a stored credential reports notConfigured instead.
interface VendorSpec {
  vendor: string;
  label: string;
  fetch: (key: string, baseUrl: string) => Promise<LimitProviderRow | LimitProviderRow[]>;
}

// baseUrl decides the GLM region: bigmodel.cn = CN site, everything else goes to the z.ai international site
function zaiRegionForBaseUrl(baseUrl: string): string {
  return baseUrl.includes("bigmodel.cn") ? "bigmodel-cn" : "global";
}

// baseUrl decides the MiniMax region: minimaxi.com = CN site, minimax.io =
// international; pinning it skips the cross-region endpoint churn (a key from
// the other region answers auth-shaped errors, costing 2-3 extra round trips
// before the right endpoint is reached). Unknown hosts keep the both-region order.
function minimaxRegionForBaseUrl(baseUrl: string): "cn" | "en" | undefined {
  return baseUrl.includes("minimaxi.com") ? "cn" : baseUrl.includes("minimax.io") ? "en" : undefined;
}

const VENDOR_SPECS: Record<string, VendorSpec> = {
  "kimi-code": {
    vendor: "kimi",
    label: "Kimi",
    fetch: (key) => fetchKimiLimits({ kimiApiKey: key }, {})
  },
  moonshot: {
    vendor: "kimi",
    label: "Kimi",
    fetch: (key) => fetchKimiLimits({ kimiApiKey: key }, {})
  },
  zai: {
    vendor: "zai",
    label: "Z.ai (GLM)",
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  "zai-coding-plan": {
    vendor: "zai",
    label: "Z.ai (GLM)",
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  "zhipu-coding-plan": {
    vendor: "zai",
    label: "Z.ai (GLM)",
    fetch: (key, baseUrl) => fetchZaiLimits({ zaiApiKey: key, zaiApiRegion: zaiRegionForBaseUrl(baseUrl) }, {})
  },
  openrouter: {
    vendor: "openrouter",
    label: "OpenRouter",
    fetch: (key) => fetchOpenRouterLimits({ openrouterProfiles: { 默认: { apiKey: key } } }, {})
  },
  deepseek: {
    vendor: "deepseek",
    label: "DeepSeek",
    fetch: (key) => fetchDeepSeekLimits({ deepseekApiKey: key }, {})
  },
  minimax: { vendor: "minimax", label: "MiniMax", fetch: (key, baseUrl) => fetchMinimaxLimits({ minimaxApiKey: key, minimaxApiHost: minimaxRegionForBaseUrl(baseUrl) }, {}) },
  "minimax-cn": { vendor: "minimax", label: "MiniMax", fetch: (key, baseUrl) => fetchMinimaxLimits({ minimaxApiKey: key, minimaxApiHost: minimaxRegionForBaseUrl(baseUrl) }, {}) },
  "minimax-code": { vendor: "minimax", label: "MiniMax", fetch: (key, baseUrl) => fetchMinimaxLimits({ minimaxApiKey: key, minimaxApiHost: minimaxRegionForBaseUrl(baseUrl) }, {}) },
  "minimax-code-cn": { vendor: "minimax", label: "MiniMax", fetch: (key, baseUrl) => fetchMinimaxLimits({ minimaxApiKey: key, minimaxApiHost: minimaxRegionForBaseUrl(baseUrl) }, {}) },
  // anthropic: the stored credential is handed to the vendor as its env token
  anthropic: {
    vendor: "claude",
    label: "Claude",
    fetch: (key) => fetchClaudeLimits({}, { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: key } })
  },
  // codex/cursor/mimo consume no credential shape this adapter can hand them
  // (codex wants a codex home, cursor a caller-injected account, mimo a pasted
  // account cookie), so their rows stay notConfigured until one is wired.
  "openai-codex": { vendor: "codex", label: "OpenAI Codex", fetch: () => fetchCodexLimits({}, {}) },
  "openai-codex-device": { vendor: "codex", label: "OpenAI Codex", fetch: () => fetchCodexLimits({}, {}) },
  cursor: { vendor: "cursor", label: "Cursor", fetch: () => fetchCursorLimits({}, {}) },
  // antigravity: omp's Google OAuth token is assembled into the vendor's managed account
  "google-antigravity": {
    vendor: "antigravity",
    label: "Google Antigravity",
    fetch: (key) =>
      fetchAntigravityLimits(
        { antigravityManagedAccounts: [{ id: "omp", accountEmail: "", credentials: { accessToken: key, expiresAt: Date.now() + 300_000 } }] },
        {}
      )
  },
  "github-copilot": {
    vendor: "copilot",
    label: "GitHub Copilot",
    fetch: (key) => fetchCopilotLimits({ copilotToken: key }, {})
  },
  xai: { vendor: "grok", label: "xAI (Grok)", fetch: (key) => fetchGrokLimits({ grokBearerToken: key }, {}) },
  "xai-oauth": { vendor: "grok", label: "xAI (Grok)", fetch: (key) => fetchGrokLimits({ grokBearerToken: key }, {}) },
  // cookie-based vendors: omp credentials are API-key shaped and don't fit; fall back to environment-variable cookies
  "alibaba-coding-plan": { vendor: "alibaba", label: "Alibaba", fetch: () => fetchAlibabaLimits({}, {}) },
  "alibaba-token-plan": { vendor: "alibaba", label: "Alibaba", fetch: () => fetchAlibabaLimits({}, {}) },
  commandcode: { vendor: "commandcode", label: "Command Code", fetch: () => fetchCommandcodeLimits({}, {}) },
  "ollama-cloud": { vendor: "ollama", label: "Ollama", fetch: () => fetchOllamaLimits({}, {}) },
  // The key-shaped vendors below take the stored credential as their own token.
  "cline-pass": { vendor: "cline", label: "Cline", fetch: (key) => fetchClineLimits({ clineApiKey: key }, {}) },
  // Devin needs an organization beside the token; authStorage only carries the
  // token, so the organization comes from the vendor's own DEVIN_ORGANIZATION
  // env lane (without it the row reports notConfigured).
  devin: { vendor: "devin", label: "Devin", fetch: (key) => fetchDevinLimits({ devinBearerToken: key }, {}) },
  "factory-droid": { vendor: "factory", label: "Factory Droid", fetch: (key) => fetchFactoryLimits({ factoryApiKey: key }, {}) },
  // Xiaomi's MiMo lane is account-cookie based and omp's API key is not that
  // cookie, so nothing is passed in: the row reports notConfigured.
  xiaomi: { vendor: "mimo", label: "MiMo", fetch: () => fetchMimoLimits({}, {}) },
  "xiaomi-token-plan-cn": { vendor: "mimo", label: "MiMo", fetch: () => fetchMimoLimits({}, {}) },
  "xiaomi-token-plan-ams": { vendor: "mimo", label: "MiMo", fetch: () => fetchMimoLimits({}, {}) },
  "xiaomi-token-plan-sgp": { vendor: "mimo", label: "MiMo", fetch: () => fetchMimoLimits({}, {}) },
  // OpenCode: the stored key is the Go API key and becomes the default account's profile
  "opencode-go": {
    vendor: "opencode",
    label: "OpenCode",
    fetch: (key) => fetchOpenCodeLimits({ opencodeProfiles: { 默认: { apiKey: key } } }, {})
  },
  "opencode-zen": {
    vendor: "opencode",
    label: "OpenCode",
    fetch: (key) => fetchOpenCodeLimits({ opencodeProfiles: { 默认: { apiKey: key } } }, {})
  },
  // cookie-based vendors: omp credentials are API-key shaped and don't fit; fall back to environment-variable tokens
  stepfun: { vendor: "stepfun", label: "StepFun", fetch: () => fetchStepfunLimits({}, {}) },
  typesafe: { vendor: "typesafe", label: "TypeSafe", fetch: () => fetchTypesafeLimits({}, {}) }
};

// When a multi-account vendor returns an array, pick the best row: ok rows with windows first, else the first row
function pickRow(result: LimitProviderRow | LimitProviderRow[]): LimitProviderRow {
  const rows = Array.isArray(result) ? result : [result];
  return rows.find((r) => r.status === "ok" && r.windows.length > 0) ?? rows[0];
}

// Query the current session provider's limits. The credential is resolved via
// authStorage.getApiKey (supports OAuth auto-renewal and env fallback) and is
// the only credential a vendor may use; no credential means no query.
// keyOverride explicitly carries a key already resolved for the session request
// (multi-account sticky alignment), null means resolved but no credential;
// cacheTag is the cache-key suffix (#id) of that key's credential, sharing the
// same cache row as the models-page accounts / background preload.
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
    if (!key) {
      row = { provider: spec.vendor, status: "notConfigured", windows: [], updatedAt: new Date().toISOString() };
    } else {
      row = pickRow(await spec.fetch(key, baseUrl));
    }
  } catch (error) {
    // errors thrown by vendor fetch carry a string status (unauthorized/rateLimited/...)
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

// Startup preload / scheduled refresh: pull quotas per credential per account
// for the given omp provider list, written under the same keys the foreground
// uses (provider#id; providers without credentials fall back to the bare
// provider key). TTL = refresh interval, so between background refreshes every
// foreground query hits cache. One provider failing does not affect the rest.
export async function refreshAllLimits(
  authStorage: AuthStorage,
  providers: Array<{ id: string; baseUrl: string }>
): Promise<void> {
  await Promise.allSettled(providers.map((p) => fetchProviderAccountsLimits(authStorage, p.id, p.baseUrl)));
}

// ---------- multi-account quotas (one provider can be logged into multiple accounts; pull quotas per credential) ----------

export interface AccountLimitRow {
  /** authStorage credential row id (0 on the single-credential fallback path) */
  id: number;
  /** Account identity: email ?? accountId ?? orgName; api_key credentials have no identity and yield an empty string */
  label: string;
  row: LimitProviderRow;
}

// Enumerate all non-disabled credentials of the provider, resolve each into a
// usable key, then pull quotas:
// - api_key: the key is directly usable
// - oauth: the access token may be expired; refresh via oauth.refresh and
//   take the latest, falling back to the stored token on failure
// No credentials (nothing stored for the provider / listAuthCredentials
// unavailable) falls back to a single-row fetchSessionLimits.
export async function fetchProviderAccountsLimits(
  authStorage: AuthStorage,
  ompProvider: string,
  baseUrl: string
): Promise<{ vendor: string | null; label: string; accounts: AccountLimitRow[] }> {
  const spec = VENDOR_SPECS[ompProvider];
  if (!spec) return { vendor: null, label: ompProvider, accounts: [] };

  let creds: Array<{ id: number; credential: AuthCredential }> = [];
  try {
    // credentials.list returns only active rows (disable tombstones stay in the store layer)
    creds = authStorage.credentials.list(ompProvider).map((c) => ({
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
        const snap = await authStorage.oauth.refresh(id);
        const c = snap?.credential;
        key = c?.type === "oauth" ? c.access : c?.type === "api_key" ? c.key : "";
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

function credentialIdentity(credential: AuthCredential): string {
  return credential?.type === "oauth" ? (credential.email ?? credential.accountId ?? credential.orgName ?? "") : "";
}

// Data source for the models page "add provider" view: the same list as the
// base TUI `/login` (getOAuthProviders), plus providers that have no base
// login flow but still accept an API key (VENDOR_SPECS-only entries, e.g.
// minimax). Quota lookup is provided separately by VENDOR_SPECS; providers
// not listed there show a "not supported yet" quota section.
export function listAllProviders(): Array<{ id: string; label: string }> {
  const rows = getOAuthProviders().map((p) => ({ id: p.id, label: p.name }));
  const seen = new Set(rows.map((r) => r.id));
  for (const [id, spec] of Object.entries(VENDOR_SPECS)) {
    if (!seen.has(id)) rows.push({ id, label: spec.label });
  }
  return rows;
}
