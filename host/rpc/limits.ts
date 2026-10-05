// Quota and context domain RPC: session quotas (get_limits, multi-account
// sticky alignment), models-page per-account quotas, context detail
// (including MCP tool schema token estimation). Moved over from the main.ts
// message dispatch (third slice).
import { Tokenizer } from "../bootstrap.ts";
import { H, sessions, type PoolEntry } from "../state.ts";
import { fetchSessionLimits, fetchProviderAccountsLimits } from "../limits/index.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

// MCP tool schema token estimate cache: skip recomputation while the tools roster identity is unchanged
const mcpTokensCache = new WeakMap<object, number>();

// MCP tools (mcp__ prefix) schema tokens are estimated separately;
// breakdown's systemToolsTokens includes all tools, so the frontend
// subtracts this to get pure built-in system tools. No recomputation while
// the roster identity is unchanged.
// Note: the published pi-coding-agent npm package lacks
// modes/utils/context-usage, so we count the wire schema JSON directly with
// Tokenizer (approximate mode) instead of importing SDK internals.
function estimateMcpToolsTokens(entry: PoolEntry): number {
  const tools = entry.session.state?.tools;
  if (!Array.isArray(tools)) return 0;
  const cached = mcpTokensCache.get(tools);
  if (cached !== undefined) return cached;
  const model = entry.session.model;
  if (!model) return 0;
  const fragments: string[] = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !tool.name.startsWith("mcp__")) continue;
    fragments.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  }
  if (fragments.length === 0) return 0;
  const tokens = new Tokenizer(model).countTokens(fragments);
  mcpTokensCache.set(tools, tokens);
  return tokens;
}

// Reverse-lookup the credential row that supplied a resolved key: the #id tag
// makes get_limits share one limits-cache row with the background refresh and
// the models-page account queries (the bare provider row is never prewarmed
// while credentials exist, so an untagged query cold-fetches on every TTL
// expiry); the label is the account identity shown on the ctx card
function accountForResolvedKey(ompProvider: string, key: string | null): { cacheTag?: string; accountLabel: string } {
  const hit = H.authStorage.credentials.list(ompProvider).find((c) => {
    const cred = c.credential;
    if (cred?.type === "api_key") return cred.key === key;
    return cred?.type === "oauth" ? cred.access === key : false;
  });
  const cred = hit?.credential;
  return {
    cacheTag: hit ? `#${hit.id}` : undefined,
    accountLabel: cred?.type === "oauth" ? (cred.email ?? cred.accountId ?? cred.orgName ?? "") : "",
  };
}

export const limitsHandlers: Record<string, RpcHandler> = {
  async get_context_detail(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const b = entry.session.getContextBreakdown();
    const st = entry.session.getSessionStats();
    ws.send(
      JSON.stringify({
        type: "context_detail",
        sessionId: msg.sessionId,
        breakdown: b ? { ...b, mcpToolsTokens: estimateMcpToolsTokens(entry) } : null,
        stats: {
          tokens: st.tokens,
          userMessages: st.userMessages,
          assistantMessages: st.assistantMessages,
          toolCalls: st.toolCalls,
          totalMessages: st.totalMessages,
          premiumRequests: st.premiumRequests,
          cost: st.cost,
        },
      }),
    );
  },
  async get_limits(ws, msg) {
    // Plan limits of the session's current provider (token-monitor port, host/limits/)
    // Without a session (empty-ring hover in the composer) allow querying by
    // msg.provider, showing only the quota section
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    const ompProvider = entry?.session.model?.provider || String(msg.provider ?? "");
    if (!ompProvider) throw new Error(hostI18n.t("errors.limits.noModelSelected"));
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
    } catch {
      baseUrl = "";
    }
    // Multi-account alignment: resolve the credential with the same
    // parameters as the request (session: providerSessionId stickiness +
    // modelId; empty-ring hover: default cascade resolution), so the detail
    // card's quota is the account the request actually hits. The #id tag
    // shares one cache row with the background preload / models page — an
    // untagged bare-provider key would cold-fetch on every TTL expiry.
    let keyOverride: string | null | undefined;
    let cacheTag: string | undefined;
    let accountLabel = "";
    if (entry) {
      const model = entry.session.model;
      keyOverride =
        (await H.authStorage.getApiKey(ompProvider, entry.providerSessionId, {
          baseUrl,
          modelId: model?.id,
        })) ?? null;
      ({ cacheTag, accountLabel } = accountForResolvedKey(ompProvider, keyOverride));
    } else {
      keyOverride = (await H.authStorage.getApiKey(ompProvider, undefined, { baseUrl })) ?? null;
      ({ cacheTag, accountLabel } = accountForResolvedKey(ompProvider, keyOverride));
    }
    const { vendor, label, row } = await fetchSessionLimits(H.authStorage, ompProvider, baseUrl, keyOverride, cacheTag);
    ws.send(
      JSON.stringify({
        type: "limits_result",
        sessionId: msg.sessionId,
        label: accountLabel ? `${label} · ${accountLabel}` : label,
        unsupported: vendor === null,
        status: row?.status ?? "unavailable",
        planLabel: row?.planLabel ?? "",
        accountLabel,
        balance: row?.balance ?? null,
        windows: row?.windows ?? [],
        updatedAt: row?.updatedAt ?? null,
      }),
    );
  },
  async get_provider_limits(ws, msg) {
    // Models page reads quotas per provider (multi-account per credential, hitting the limits 60s cache)
    const ompProvider = String(msg.provider ?? "");
    if (!ompProvider) throw new Error(hostI18n.t("errors.param.missingProvider"));
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
    } catch {
      baseUrl = "";
    }
    const { vendor, label, accounts } = await fetchProviderAccountsLimits(H.authStorage, ompProvider, baseUrl);
    const first = accounts[0]?.row;
    ws.send(
      JSON.stringify({
        type: "provider_limits_result",
        provider: ompProvider,
        label,
        unsupported: vendor === null,
        // Top-level fields take the first account (compatible with single-account consumers); with multiple accounts the frontend reads accounts and renders each
        status: first?.status ?? "unavailable",
        planLabel: first?.planLabel ?? "",
        accountLabel: accounts[0]?.label || first?.accountLabel || "",
        balance: first?.balance ?? null,
        windows: first?.windows ?? [],
        updatedAt: first?.updatedAt ?? null,
        accounts: accounts.map((a) => ({
          id: a.id,
          label: a.label || a.row.accountLabel || "",
          status: a.row.status ?? "unavailable",
          planLabel: a.row.planLabel ?? "",
          accountLabel: a.row.accountLabel ?? "",
          balance: a.row.balance ?? null,
          windows: a.row.windows ?? [],
          updatedAt: a.row.updatedAt ?? null,
        })),
      }),
    );
  },
};
