// ACP compaction stats (usage-stats "ACP" section): one row per acpSummary entry.
//
// Two halves join here. The runtime records what only it can know at write time
// (meta.summaryTokens / statusTokens / hints, host/acp-runtime.ts); everything
// else is replayed from the journal's own usage records — the round's extra
// cost (the context_status and compress_context calls plus the request each one
// triggers) and the tokens the fold kept out of the requests after it, priced
// at the compressing model's cache-read rate.
//
// The scan mirrors acp-gain (mtime-cached per journal), with one difference:
// acp-gain aggregates and can skip lines, this needs the usage stream in
// journal order, so it parses every message line and derives rows afterwards.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "./bootstrap.ts";

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
  /** Tokens of the context_status and compress_context calls plus the request each one triggered. */
  extraTokens: number;
  extraCost: number;
  /** Requests after this compression in the same session (the multiplier behind savedTokens). */
  requestsAfter: number;
  savedTokens: number;
  savedCost: number;
}

interface UsageSample {
  /** Journal position (monotonic across usage and summary entries). */
  pos: number;
  model: string;
  totalTokens: number;
  cost: number;
  input: number;
  costInput: number;
  cacheRead: number;
  costCacheRead: number;
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

function parseUsage(pos: number, message: Record<string, unknown>): UsageSample | null {
  if (message.role !== "assistant") return null;
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const tools = new Set<string>();
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const c = asRecord(block);
    if (c && c.type === "toolCall" && typeof c.name === "string") tools.add(c.name);
  }
  return {
    pos,
    model: typeof message.model === "string" ? message.model : "unknown",
    totalTokens: num(usage.totalTokens),
    cost: num(cost?.total),
    input: num(usage.input),
    costInput: num(cost?.input),
    cacheRead: num(usage.cacheRead),
    costCacheRead: num(cost?.cacheRead),
    tools,
  };
}

/** Derive rows for one journal. Pure over the file text, so the journal walk is testable in isolation. */
export function parseAcpStatsJournal(text: string): AcpCompactionRow[] {
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
      const sample = message ? parseUsage(pos, message) : null;
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
        ? compress.costCacheRead / compress.cacheRead
        : compress && compress.input > 0
          ? compress.costInput / compress.input
          : 0;
    const savedTokens = compressedTokens * requestsAfter;
    const telemetry = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
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
      extraTokens: [...extra].reduce((n, u) => n + u.totalTokens, 0),
      extraCost: [...extra].reduce((n, u) => n + u.cost, 0),
      requestsAfter,
      savedTokens,
      savedCost: savedTokens * cacheReadPrice,
    });
  }
  return rows;
}

async function scanFile(path: string): Promise<FileScan> {
  const mtimeMs = (await stat(path)).mtimeMs;
  const cached = scanCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const scan: FileScan = { mtimeMs, rows: parseAcpStatsJournal(await readFile(path, "utf-8")) };
  scanCache.set(path, scan);
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
        for (const row of (await scanFile(path)).rows) {
          if (row.createdAt >= cutoff) rows.push(row);
        }
      } catch {
        // unreadable/locked journal: skip it, one session's data is not worth failing the dashboard
      }
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
