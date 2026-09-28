// 配额与上下文域 RPC：会话配额（get_limits，多账号粘性对齐）、模型页逐账号配额、
// 上下文明细（含 MCP 工具 schema token 估算）。自 main.ts message 分发平移（第三刀）。
import { Tokenizer } from "../bootstrap.ts";
import { H, sessions, type PoolEntry } from "../state.ts";
import { fetchSessionLimits, fetchProviderAccountsLimits } from "../limits/index.ts";
import type { RpcHandler } from "./types";

// MCP 工具 schema token 估算缓存:tools roster 身份不变就不重算
const mcpTokensCache = new WeakMap<object, number>();

// MCP 工具(mcp__ 前缀)schema token 单独估算;breakdown 的 systemToolsTokens 含全部工具,
// 前端展示时减去即得纯内置系统工具。roster 身份不变就不重算。
// 注:发布的 pi-coding-agent npm 包不含 modes/utils/context-usage,这里用
// Tokenizer 直接数 wire schema JSON(approximate 模式),不引 SDK 内部模块。
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

export const limitsHandlers: Record<string, RpcHandler> = {
  async get_context_detail(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
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
    // 会话当前供应商的套餐限额(token-monitor 移植逻辑,host/limits/)
    // 无会话时(UI 输入框空环 hover)允许按 msg.provider 查询,只显示配额段
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    const ompProvider = entry?.session.model?.provider || String(msg.provider ?? "");
    if (!ompProvider) throw new Error("会话尚未选择模型");
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(ompProvider) ?? "";
    } catch {
      baseUrl = "";
    }
    // 多账号对齐:与会话请求同参(providerSessionId 粘性 + modelId)解析凭证,
    // 明细卡配额即本会话实际命中的账号;key 反查凭证 id 后以 #id 为缓存键
    // (与模型页 accounts/后台预载共用同一缓存行),身份标签一并回填
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
      const hit = (H.authStorage.listStoredCredentials?.(ompProvider) ?? []).find((c: any) => {
        const cred = c.credential;
        return cred?.type === "api_key" ? cred.key === keyOverride : cred?.access === keyOverride;
      });
      if (hit) cacheTag = `#${hit.id}`;
      const cred: any = hit?.credential;
      accountLabel = cred?.email ?? cred?.accountId ?? cred?.orgName ?? "";
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
    // 模型管理页按供应商读配额(多账号逐凭证,命中 limits 60s 缓存)
    const ompProvider = String(msg.provider ?? "");
    if (!ompProvider) throw new Error("缺少 provider");
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
        // 顶层字段取首个账号(单账号消费方兼容);多账号时前端读 accounts 逐段渲染
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
