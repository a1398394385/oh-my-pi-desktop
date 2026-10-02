/**
 * pi-kimi-keepalive pure-function library (ported from
 * https://github.com/realOliverSama/pi-kimi-keepalive a05bafd / v0.3.8,
 * source file src/lib.ts). Deliberately free of any pi host imports;
 * probe request construction / usage parsing / cost estimation stay pure
 * functions for easy unit testing.
 * No logic was changed during the port; only this header comment was added.
 */

export interface CostPerM {
  /** USD per 1M input tokens (cache miss). */
  input: number;
  /** USD / 1M output tokens. */
  output: number;
  /** USD / 1M cache-read input tokens. */
  cacheRead: number;
}

/** Headers that must never be forwarded to a re-issued request. */
const FORBIDDEN_HEADERS = new Set([
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "expect",
]);

/**
 * Build headers for a probe request from the headers captured on the last
 * real provider request. Auth / routing headers are forwarded verbatim;
 * hop-by-hop and length headers are dropped (fetch sets its own).
 */
export function buildProbeHeaders(captured: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower === "content-type") continue;
    out[key] = value;
  }
  out["content-type"] = "application/json";
  return out;
}

/** Transport dialect a captured payload is written in. */
export type ProbeDialect = "anthropic-messages" | "openai-completions";

/**
 * Dialect the captured payload actually uses.
 *
 * The model's advertised api id is not authoritative: a host may route a
 * provider onto an Anthropic-shaped body while the catalog still reports
 * `openai-completions` (oh-my-pi does exactly this for kimi-code, whose
 * transport picks its protocol per model). The captured body is, so its
 * markers decide — replaying an Anthropic body at the OpenAI endpoint is
 * rejected before the prefix cache is ever consulted.
 */
export function resolveProbeDialect(payload: unknown, api: string | undefined): ProbeDialect {
  if (api === "anthropic-messages") return "anthropic-messages";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "openai-completions";
  const body = payload as Record<string, unknown>;
  // Anthropic-only request fields.
  if ("output_config" in body || "context_management" in body) return "anthropic-messages";
  // Anthropic carries the system turn in a top-level `system`; OpenAI puts it
  // inside `messages` and clamps output with `max_completion_tokens`.
  if (Array.isArray(body.system)) return "anthropic-messages";
  if ("max_tokens" in body && !("max_completion_tokens" in body)) return "anthropic-messages";
  return "openai-completions";
}

/**
 * Build a keepalive probe body from a captured provider payload.
 *
 * The conversation prefix (messages / tools / system role, plus Kimi's
 * prompt_cache_key / prompt_cache_retention) is kept byte-identical so the
 * request hits the same automatic prefix cache. Only terminal parameters
 * change: non-streaming and a tiny output clamp.
 *
 * `dialect` selects the body's shape (see {@link resolveProbeDialect}):
 * anthropic-messages uses max_tokens / optional tool_choice:{type:"none"};
 * everything else is treated as the OpenAI-completions style
 * (max_completion_tokens; stream_options / thinking / store removed).
 * attempt 2 drops prompt_cache_retention when the endpoint rejects a
 * terminal parameter (HTTP 400) — the prefix is never modified.
 */
export function buildProbeBody(
  payload: unknown,
  maxOutputTokens: number,
  dialect: ProbeDialect,
  attempt: 1 | 2,
): { ok: true; body: Record<string, unknown> } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "captured payload is not an object" };
  }
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, reason: "captured payload has no messages array" };
  }
  if (
    raw.system !== undefined &&
    !Array.isArray(raw.system) &&
    typeof raw.system !== "string"
  ) {
    return { ok: false, reason: "captured payload system field has an unexpected shape" };
  }

  const body: Record<string, unknown> = structuredClone(raw);
  if (dialect === "anthropic-messages") {
    delete body.stream;
    delete body.stream_options;
    // thinking must go with a tiny max_tokens: Anthropic-style APIs require
    // max_tokens > thinking.budget_tokens, and thinking is not part of the
    // prompt prefix that feeds the cache key.
    delete body.thinking;
    body.max_tokens = Math.max(1, Math.floor(maxOutputTokens));
    if (attempt === 1) body.tool_choice = { type: "none" };
    else delete body.tool_choice;
    return { ok: true, body };
  }
  // OpenAI-completions style (kimi-openai-completions and friends).
  delete body.stream;
  delete body.stream_options;
  delete body.thinking;
  delete body.store;
  delete body.tool_choice;
  body.max_completion_tokens = Math.max(1, Math.floor(maxOutputTokens));
  if (attempt === 2) delete body.prompt_cache_retention;
  return { ok: true, body };
}

export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Extract usage from a non-streaming response, tolerating both the
 * Anthropic-style field names (cache_read_input_tokens) pi uses for
 * anthropic-messages routes and OpenAI-style cached_tokens just in case a
 * gateway renames fields.
 */
export function parseUsage(data: unknown): ParsedUsage {
  const out: ParsedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!data || typeof data !== "object") return out;
  const usageRaw = (data as { usage?: unknown }).usage;
  if (!usageRaw || typeof usageRaw !== "object") return out;
  const u = usageRaw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

  // An Anthropic response reports `input_tokens` as the *uncached* remainder
  // and bills cache reads through `cache_read_input_tokens`; an OpenAI one
  // folds cache reads into `prompt_tokens` and breaks them out in
  // `prompt_tokens_details`. Track the Anthropic pair to normalize below.
  const anthropicCached = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  out.inputTokens = num(u.input_tokens) || num(u.prompt_tokens);
  out.outputTokens = num(u.output_tokens) || num(u.completion_tokens);
  out.cacheReadTokens = num(u.cache_read_input_tokens);
  out.cacheWriteTokens = num(u.cache_creation_input_tokens);
  if (out.cacheReadTokens === 0) {
    const details = u.prompt_tokens_details;
    if (details && typeof details === "object") {
      out.cacheReadTokens = num((details as Record<string, unknown>).cached_tokens);
    }
  }
  if (out.cacheReadTokens === 0) {
    out.cacheReadTokens = num(u.cached_tokens);
  }
  // Normalize both dialects to the total prompt size, so hit rate, miss
  // detection, and spend accounting all share one unit.
  if (anthropicCached > 0) out.inputTokens += anthropicCached;
  return out;
}

/** Best-effort usage extraction from an unexpectedly streamed (SSE) body. */
export function parseUsageFromSse(text: string): ParsedUsage {
  // Scan text/event-stream lines for the richest usage object seen.
  const result: ParsedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const re = /"usage"\s*:\s*\{[^{}]*\}/g;
  for (const match of text.matchAll(re)) {
    try {
      const parsed = parseUsage(JSON.parse(`{${match[0]}}`));
      result.inputTokens = Math.max(result.inputTokens, parsed.inputTokens);
      result.outputTokens = Math.max(result.outputTokens, parsed.outputTokens);
      result.cacheReadTokens = Math.max(result.cacheReadTokens, parsed.cacheReadTokens);
      result.cacheWriteTokens = Math.max(result.cacheWriteTokens, parsed.cacheWriteTokens);
    } catch {
      // ignore malformed fragments
    }
  }
  return result;
}

/** True when the probe returned but the prefix cache did not serve it. */
export function isCacheMiss(inputTokens: number, cacheReadTokens: number, minPromptTokens: number): boolean {
  return cacheReadTokens === 0 && inputTokens >= minPromptTokens;
}

/** USD saved by this probe hitting cache instead of a cold full-price read. */
export function estimateSavedUsd(cacheReadTokens: number, cost: Partial<CostPerM> | undefined): number {
  if (!cost || cacheReadTokens <= 0) return 0;
  const input = typeof cost.input === "number" ? cost.input : 0;
  const cacheRead = typeof cost.cacheRead === "number" ? cost.cacheRead : 0;
  const delta = input - cacheRead;
  if (delta <= 0) return 0;
  return (cacheReadTokens / 1_000_000) * delta;
}

/** Actual USD the probe itself is expected to cost (read + output pricing). */
export function estimateProbeSpendUsd(usage: ParsedUsage, cost: Partial<CostPerM> | undefined): number {
  if (!cost) return 0;
  const input = typeof cost.input === "number" ? cost.input : 0;
  const outputP = typeof cost.output === "number" ? cost.output : 0;
  const cacheRead = typeof cost.cacheRead === "number" ? cost.cacheRead : input;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  const usd =
    (usage.cacheReadTokens / 1_000_000) * cacheRead +
    (uncached / 1_000_000) * input +
    (usage.outputTokens / 1_000_000) * outputP;
  return usd;
}

/** "3m12s" style formatting. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function formatUsd(usd: number): string {
  const abs = Math.abs(usd);
  if (abs >= 1) return `$${usd.toFixed(2)}`;
  if (abs === 0) return "$0.00";
  return `$${usd.toFixed(4)}`;
}
