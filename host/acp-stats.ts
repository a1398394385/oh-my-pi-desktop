// ACP compaction stats (usage-stats "ACP" section): one row per acpSummary entry.
//
// Two halves join here. The runtime records what only it can know at write time
// (meta.summaryTokens / statusTokens / hints, host/acp-runtime.ts); everything
// else is replayed from the journal's own usage records — the round's extra
// cost (the context_status and compress_context calls plus the request each one
// triggers) and the tokens the fold kept out of the requests after it, priced
// at the compressing model's cache-read rate. Requests whose provider recorded
// no cost (subscription plans) are repriced from the bundled catalog in
// host/catalog-cost.ts, so those rows still carry an API-equivalent figure.
//
// The scan mirrors acp-gain (mtime-cached per journal), with one difference:
// acp-gain aggregates and can skip lines, this needs the usage stream in
// journal order, so it parses every message line and derives rows afterwards.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@oh-my-pi/pi-catalog/types";
import { getSessionsDir } from "./bootstrap.ts";
import type { UsagePricer } from "./catalog-cost.ts";
import { priceUsage } from "./catalog-cost.ts";

const RANGE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  "90d": 7_776_000_000,
  all: Number.POSITIVE_INFINITY,
};

/** One ACP compression (an acpSummary entry) with its round cost and its measured saving. */
export interface AcpCompactionRow {
  /** acpSummary entry id (row key). */
  id: string;
  createdAt: number;
  /** Model that ran the compression (nearest compress_context call); "unknown" when the journal has no usage. */
  model: string;
  cwd: string | null;
  /** Tokens folded out of the active zone by this compression (meta.tokensBefore - tokensAfter). */
  compressedTokens: number;
  /** Active-zone tokens left after the compression (meta.tokensAfter). */
  activeTokensAfter: number;
  /** Rendered size of the generated compaction block; null on journals written before the telemetry existed. */
  summaryTokens: number | null;
  /** Tokens of the context_status return that fed this compression; null when not recorded. */
  statusTokens: number | null;
  /** [compress-hint] injections since the previous compression (or session start); null when not recorded. */
  hints: number | null;
  /** Tokens of the context_status and compress_context calls plus the request each one triggered, split by bucket. */
  extraInput: number;
  extraOutput: number;
  extraCacheRead: number;
  extraCacheWrite: number;
  extraCost: number;
  /** Requests after this compression in the same session (the multiplier behind savedTokens). */
  requestsAfter: number;
  savedTokens: number;
  savedCost: number;
}

interface UsageSample {
  /** Journal position (monotonic across usage and summary entries). */
  pos: number;
  provider: string;
  model: string;
  /** Request timestamp (Unix ms), 0 when the entry recorded none. */
  timestamp: number;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Recorded cost, repriced from the bundled catalog when the provider reported none. */
  cost: Usage["cost"];
  tools: Set<string>;
}

interface FileScan {
  mtimeMs: number;
  rows: AcpCompactionRow[];
}

/** path → last scan; journals are append-only, so a matching mtime is a hit. */
const scanCache = new Map<string, FileScan>();

// Session journals are user-editable files: every field is narrowed before use.
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseUsage(pos: number, message: Record<string, unknown>, price?: UsagePricer): UsageSample | null {
  if (message.role !== "assistant") return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const tools = new Set<string>();
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const c = asRecord(block);
    if (c && c.type === "toolCall" && typeof c.name === "string") tools.add(c.name);
  }
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const timestamp = num(message.timestamp);
  const tokens = {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    totalTokens: num(usage.totalTokens),
  };
  const recorded: Usage["cost"] = {
    input: num(cost?.input),
    output: num(cost?.output),
    cacheRead: num(cost?.cacheRead),
    cacheWrite: num(cost?.cacheWrite),
    total: num(cost?.total),
  };
  // A recorded zero is unknown spend for subscription/free-tier providers, not a
  // free request: the bundled catalog's list rate keeps the row an API-equivalent
  // estimate. Tokens with no billable catalog row stay at zero.
  const repriced = recorded.total === 0 && tokens.totalTokens > 0 ? price?.(provider, model, { ...tokens, cost: recorded }, timestamp) : null;
  return {
    pos,
    provider,
    model,
    timestamp,
    ...tokens,
    cost: repriced ?? recorded,
    tools,
  };
}

/**
 * Derive rows for one journal. Pure over the file text, so the journal walk is
 * testable in isolation; `price` supplies the catalog list rate used to reprice
 * requests whose provider reported no cost.
 */
export function parseAcpStatsJournal(text: string, price?: UsagePricer): AcpCompactionRow[] {
  const usage: UsageSample[] = [];
  const summaries: Array<{ id: string; pos: number; meta: Record<string, unknown> | null }> = [];
  let cwd: string | null = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    // Cheap prefilter: a stats scan must not JSON.parse every text/message line of a large journal.
    if (!line.includes('"type":"message"') && !line.includes("acpSummary") && !line.includes('"type":"session"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn tail line while a session is being written
    }
    if (entry.type === "session") {
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      continue;
    }
    if (entry.type === "message") {
      const message = asRecord(entry.message);
      const sample = message ? parseUsage(pos, message, price) : null;
      if (sample) usage.push(sample);
      pos++;
    } else if (entry.type === "custom" && entry.customType === "acpSummary") {
      const data = asRecord(entry.data);
      if (typeof entry.id === "string" && data) {
        summaries.push({ id: entry.id, pos, meta: asRecord(data.meta) });
      }
      pos++;
    }
  }

  const rows: AcpCompactionRow[] = [];
  for (const summary of summaries) {
    const meta = summary.meta;
    if (!meta) continue;
    const createdAt = num(meta.createdAt);
    if (createdAt <= 0) continue;
    // cursor() scans backwards from the journal position: the calls that produced
    // this block are the last ones before it.
    const lastWith = (tool: string): UsageSample | undefined => {
      for (let i = usage.length - 1; i >= 0; i--) {
        const u = usage[i];
        if (u.pos >= summary.pos) continue;
        if (u.tools.has(tool)) return u;
      }
      return undefined;
    };
    const firstAfter = (pos: number): UsageSample | undefined => usage.find((u) => u.pos > pos);
    const compress = lastWith("compress_context");
    const status = lastWith("context_status");
    const extra = new Set<UsageSample>();
    for (const anchor of [status, compress]) {
      if (!anchor) continue;
      extra.add(anchor);
      const next = firstAfter(anchor.pos);
      if (next) extra.add(next);
    }
    const before = num(meta.tokensBefore);
    const after = num(meta.tokensAfter);
    const compressedTokens = Math.max(0, before - after);
    const requestsAfter = usage.filter((u) => u.pos > summary.pos).length;
    // Cache-read unit price of the compressing model: what one folded token would
    // have cost on every later request. Without cache reads on that call, the
    // input rate is the closest same-model figure (never a foreign model's).
    const cacheReadPrice =
      compress && compress.cacheRead > 0
        ? compress.cost.cacheRead / compress.cacheRead
        : compress && compress.input > 0
          ? compress.cost.input / compress.input
          : 0;
    const savedTokens = compressedTokens * requestsAfter;
    const telemetry = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const extraTokens = (bucket: "input" | "output" | "cacheRead" | "cacheWrite") =>
      [...extra].reduce((n, u) => n + u[bucket], 0);
    rows.push({
      id: summary.id,
      createdAt,
      model: compress?.model ?? "unknown",
      cwd,
      compressedTokens,
      activeTokensAfter: after,
      summaryTokens: telemetry(meta.summaryTokens),
      statusTokens: telemetry(meta.statusTokens),
      hints: telemetry(meta.hints),
      extraInput: extraTokens("input"),
      extraOutput: extraTokens("output"),
      extraCacheRead: extraTokens("cacheRead"),
      extraCacheWrite: extraTokens("cacheWrite"),
      extraCost: [...extra].reduce((n, u) => n + u.cost.total, 0),
      requestsAfter,
      savedTokens,
      savedCost: savedTokens * cacheReadPrice,
    });
  }
  return rows;
}

async function scanFile(path: string, price?: UsagePricer): Promise<FileScan> {
  // Journals are append-only, so a matching mtime is a hit; the priced flag keeps
  // a cached unpriced scan from serving a later priced request for the same file.
  const key = `${price ? "p" : "r"}:${path}`;
  const mtimeMs = (await stat(path)).mtimeMs;
  const cached = scanCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const scan: FileScan = { mtimeMs, rows: parseAcpStatsJournal(await readFile(path, "utf-8"), price) };
  scanCache.set(key, scan);
  return scan;
}

/** Every ACP compression in this profile's sessions within `range`, newest first. */
export async function collectAcpCompactionStats(range?: string | null): Promise<AcpCompactionRow[]> {
  const cutoff = Date.now() - (RANGE_MS[range ?? ""] ?? RANGE_MS.all);
  const root = getSessionsDir();
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const rows: AcpCompactionRow[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await readdir(join(root, dir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // per-session subdirectory (subagent transcripts), not a cwd folder
    }
    for (const file of files) {
      const path = join(root, dir, file);
      try {
        if ((await stat(path)).mtimeMs < cutoff) continue; // coarse prefilter; rows re-check createdAt
        for (const row of (await scanFile(path, priceUsage)).rows) {
          if (row.createdAt >= cutoff) rows.push(row);
        }
      } catch {
        // unreadable/locked journal: skip it, one session's data is not worth failing the dashboard
      }
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
