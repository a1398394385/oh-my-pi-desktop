// ACP compaction gain for the stats Gain page: scans session journals for
// acpSummary entries and aggregates the tokens folded out of the LLM context.
// The base gain-aggregator only knows snapcompact and the base source is
// off-limits (ADR-0005 v9), so stats.ts merges this into /api/stats/gain.
//
// A block's benefit is counted once per ORIGINAL block id, not per summary:
// a strong compaction block inherits the superseded blocks' index entries, and
// re-counting those would double-report. The dedupe set is rebuilt per query
// over append-only journals, so a fresh build stays correct.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "./bootstrap.ts";

/** Same token→byte estimate the base gain-aggregator uses for mixed sources. */
const BYTES_PER_TOKEN = 4;

const RANGE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  "90d": 7_776_000_000,
  all: Number.POSITIVE_INFINITY,
};

interface AcpRecord {
  createdAt: number;
  /** Original block ids folded by this summary, with their pre-fold tokens. */
  blocks: Array<{ id: string; tokens: number }>;
}

interface FileScan {
  mtimeMs: number;
  cwd: string | null;
  records: AcpRecord[];
}

/** path → last scan; journals are append-only, so a matching mtime is a hit. */
const scanCache = new Map<string, FileScan>();

// Session journals are user-editable files: every field is narrowed before use.
// The object casts here follow the runtime typeof checks and only give the
// compiler the shape those checks already proved.
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseEntry(line: string): Record<string, unknown> | null {
  if (!line.includes("acpSummary") && !line.includes('"session"')) return null;
  const v = asRecord(JSON.parse(line));
  return v && typeof v.type === "string" ? v : null;
}

async function scanFile(path: string): Promise<FileScan> {
  const mtimeMs = (await stat(path)).mtimeMs;
  const cached = scanCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const text = await readFile(path, "utf-8");
  let cwd: string | null = null;
  const records: AcpRecord[] = [];
  for (const line of text.split("\n")) {
    let entry: Record<string, unknown> | null = null;
    try {
      entry = parseEntry(line);
    } catch {
      continue; // torn tail line while a session is being written
    }
    if (!entry) continue;
    if (entry.type === "session") {
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
    } else if (entry.type === "custom" && entry.customType === "acpSummary") {
      const data = asRecord(entry.data);
      const meta = asRecord(data?.meta);
      const createdAt = meta && typeof meta.createdAt === "number" ? meta.createdAt : null;
      if (!data || createdAt === null) continue;
      const blocks: AcpRecord["blocks"] = [];
      const index = Array.isArray(data.index) ? data.index : [];
      for (const raw of index) {
        const l = asRecord(raw);
        if (l && typeof l.id === "string" && typeof l.tokens === "number") blocks.push({ id: l.id, tokens: l.tokens });
      }
      records.push({ createdAt, blocks });
    }
  }
  const scan: FileScan = { mtimeMs, cwd, records };
  scanCache.set(path, scan);
  return scan;
}

/** True when `candidate` equals `parent` or is a separator-bounded sub-path (base matchesProject semantics). */
function isSameOrSubPath(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  return candidate.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export interface AcpGain {
  savedTokens: number;
  hits: number;
  byDay: Record<string, number>;
  projects: string[];
}

/** Aggregate ACP compaction gain across all session journals of this profile. */
export async function collectAcpGain(range?: string | null, project?: string | null): Promise<AcpGain> {
  const cutoff = Date.now() - (RANGE_MS[range ?? ""] ?? RANGE_MS.all);
  const root = getSessionsDir();
  let savedTokens = 0;
  let hits = 0;
  const byDay: Record<string, number> = {};
  const projects = new Set<string>();
  const counted = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return { savedTokens: 0, hits: 0, byDay, projects: [] };
  }
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
        if ((await stat(path)).mtimeMs < cutoff) continue; // coarse prefilter; records re-check createdAt
        const scan = await scanFile(path);
        if (project && !(scan.cwd && isSameOrSubPath(scan.cwd, project))) continue;
        for (const rec of scan.records) {
          if (rec.createdAt < cutoff) continue;
          let fresh = 0;
          for (const b of rec.blocks) {
            if (counted.has(b.id)) continue;
            counted.add(b.id);
            fresh += b.tokens;
          }
          if (fresh <= 0) continue;
          savedTokens += fresh;
          hits += 1;
          // Only sessions that contributed land in the selector (base semantics: the
          // project list comes from records, not from every scanned journal).
          if (scan.cwd) projects.add(scan.cwd);
          const day = new Date(rec.createdAt).toISOString().slice(0, 10);
          byDay[day] = (byDay[day] ?? 0) + fresh;
        }
      } catch {
        // unreadable/locked journal: skip it, one session's data is not worth failing the dashboard
      }
    }
  }
  return { savedTokens, hits, byDay, projects: [...projects] };
}

/** savedBytes for the GainSourceTotals shape (estimate, same 4 bytes/token as the base). */
export function acpSavedBytes(tokens: number): number {
  return tokens * BYTES_PER_TOKEN;
}
