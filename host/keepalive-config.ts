/**
 * Cache keepalive config domain (desktop adaptation layer of the pi-kimi-keepalive
 * a05bafd / v0.3.8 port, self-owned).
 *
 * Upstream keeps probe parameters in ~/.omp/cache-keepalive/state.json (one
 * global copy, shared with the CLI); the desktop port, per user request, moved
 * them into the keepalive section of omp-desktop.json — naturally per-profile
 * (H.desktopProjectsPath is the current profile's agent dir). The single
 * switch in the section:
 *   enabled whether this app injects the extension and probes (consumed by
 *           session-lifecycle, default false; on = probing on — the desktop
 *           domain has no second-layer probe switch: injection itself is the
 *           user's explicit paid confirmation, unlike upstream's two-layer
 *           config.enabled semantics)
 * The probe-log.jsonl audit log stays in ~/.omp/cache-keepalive/ (append-only,
 * no config semantics).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { H } from "./state.ts";

export const STATE_DIR = join(homedir(), ".omp", "cache-keepalive");
export const PROBE_LOG_FILE = join(STATE_DIR, "probe-log.jsonl");

/** Fallback timeout for a single probe request. */
export const PROBE_TIMEOUT_MS = 30_000;
/** Lower bound of the probe cadence (same constraint as the upstream CLI command layer: 30s). */
export const MIN_INTERVAL_MS = 30_000;

export interface ProbeConfig {
  /** Keepalive target models (catalog id "provider/model"; empty = probe no model).
   *  Upstream hardcodes kimi-code; the desktop version generalizes it into a selectable model list per user request. */
  targets: string[];
  intervalMs: number;
  /** 0 = never stop due to idleness. */
  maxIdleMs: number;
  /** Minimum full-price prompt size (tokens) before a probe counts as a miss. */
  minPromptTokens: number;
  /** max_tokens clamp for probe requests. */
  maxOutputTokens: number;
  /** Session probe-spend ceiling in USD; null disables the cap. */
  spendCapUsd: number | null;
  /** Consecutive cache misses before probing pauses. */
  maxMissStreak: number;
  /** Consecutive failed probes (network/server errors) before probing pauses. */
  maxErrorStreak: number;
  /** "default" = fixed interval; "smart" = adaptive cadence that grows while probes keep hitting. */
  mode: "default" | "smart";
}

export const DEFAULT_PROBE_CONFIG: Readonly<ProbeConfig> = Object.freeze({
  targets: [],
  // 8 min: the cadence upstream real-world testing validated — the effective
  // TTL runs longer than the ~5 min nominal one, so 8 min keeps real margin,
  // while a longer heartbeat (10 min) starts missing the expired entry. Every
  // probe is billed at cache-read rates (~10x cheaper than a cold read). If
  // probe is billed at cache-read rates (~10x cheaper than a cold read). If
  // the cache still expires (e.g. server-side eviction), the probe misses once
  // at full price and the default miss=1 stops probing immediately.
  intervalMs: 8 * 60_000,
  maxIdleMs: 60 * 60_000,
  minPromptTokens: 512,
  maxOutputTokens: 16,
  spendCapUsd: 1.0,
  maxMissStreak: 1,
  maxErrorStreak: 3,
  mode: "default",
});

// smart-mode constants
export const SMART_BASE_MS = 8 * 60_000; // smart starting/floor cadence (matches the default interval)
export const SMART_STEP_MS = 30_000; // +30s per 3-hit confirmation
export const SMART_CONFIRM_HITS = 3;
export const SMART_MAX_CONTEXT_TOKENS = 200_000; // context cap: grow only below this
/**
 * default-mode safe floor: the nominal cache TTL. A miss while probing above
 * this cadence drops the cadence here and keeps probing (the miss probe
 * itself rebuilds the cache entry, so the next ≤5m probe renews it); only a
 * miss AT this floor counts toward the miss-pause threshold.
 */
export const DEFAULT_FALLBACK_MS = 5 * 60_000;

// ---------- atomic read/write of the omp-desktop.json keepalive section ----------

/** Read the full omp-desktop.json (missing/corrupt file falls back to an empty object — same tolerance as profile.ts). */
function readDesktopJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read the keepalive section (missing/invalid falls back to an empty object). */
function readSection(): Record<string, unknown> {
  const section = readDesktopJson().keepalive;
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** Merge-write the keepalive section, preserving omp-desktop.json's other keys and unmentioned fields inside the section. */
function writeSection(section: Record<string, unknown>): void {
  const raw = readDesktopJson();
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, keepalive: section }, null, 2));
}

// ---------- injection switch (enabled) ----------

/** Whether this app injects the cache keepalive extension (keepalive.enabled in omp-desktop.json, off by default). */
export function readKeepaliveEnabled(): boolean {
  return readSection().enabled === true;
}

/** Write keepalive.enabled back. */
export function writeKeepaliveEnabled(enabled: boolean): void {
  writeSection({ ...readSection(), enabled });
}

// ---------- probe parameters (numeric fields; start/stop is carried by the section's single switch, enabled) ----------

/**
 * Normalization (clamp logic faithfully migrated from upstream
 * readConfigFromDisk): invalid/missing values clamp back to defaults.
 */
function normalizeProbeConfig(raw: Record<string, unknown>): ProbeConfig {
  const int = (value: unknown, fallback: number, min = 1, cap = Number.MAX_SAFE_INTEGER): number =>
    typeof value === "number" && Number.isFinite(value) && value >= min
      ? Math.min(Math.floor(value), cap)
      : fallback;
  return {
    targets: Array.isArray(raw.targets)
      ? raw.targets.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
      : DEFAULT_PROBE_CONFIG.targets,
    intervalMs: int(raw.intervalMs, DEFAULT_PROBE_CONFIG.intervalMs, 1_000),
    maxIdleMs:
      raw.maxIdleMs === 0
        ? 0
        : int(raw.maxIdleMs, DEFAULT_PROBE_CONFIG.maxIdleMs),
    minPromptTokens: int(raw.minPromptTokens, DEFAULT_PROBE_CONFIG.minPromptTokens, 0),
    maxOutputTokens: int(raw.maxOutputTokens, DEFAULT_PROBE_CONFIG.maxOutputTokens, 1, 4096),
    spendCapUsd:
      raw.spendCapUsd === 0 || raw.spendCapUsd === null
        ? null // 0/null both mean "no cap"
        : typeof raw.spendCapUsd === "number" &&
            Number.isFinite(raw.spendCapUsd) &&
            raw.spendCapUsd > 0
          ? raw.spendCapUsd
          : DEFAULT_PROBE_CONFIG.spendCapUsd,
    maxMissStreak: int(raw.maxMissStreak, DEFAULT_PROBE_CONFIG.maxMissStreak, 1),
    maxErrorStreak: int(raw.maxErrorStreak, DEFAULT_PROBE_CONFIG.maxErrorStreak, 1),
    mode: raw.mode === "smart" ? "smart" : "default",
  };
}

/** Current probe config at extension load (same source as the settings frame; defaults when the section is absent). */
export function readKeepaliveProbeConfig(): ProbeConfig {
  return normalizeProbeConfig(readSection());
}

/**
 * Parse "90s" | "4m" | "1h30m" | "2.5m" | bare minutes. Returns ms or null.
 * Restored from upstream lib.ts + compound segments added: upstream HELP text
 * promises the "4m45s" form but the original regex only accepted a single
 * segment (an upstream self-inconsistency); UI fmtDur also emits compound
 * formats, so support them here too.
 */
export function parseDurationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  if (/^\d+$/.test(text)) {
    // bare number = minutes (upstream semantics)
    const v = Number(text);
    return v > 0 ? Math.round(v * 60_000) : null;
  }
  let total = 0;
  let matched = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    matched += m[0].length;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    total += v * (m[2] === "ms" ? 1 : m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000);
  }
  if (matched !== text.length || total <= 0) return null;
  return Math.round(total);
}

/** Parse "$1.5" | "1.5" into USD, or null. (restored verbatim from upstream lib.ts) */
export function parseUsd(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d+)?$/.test(text))
    return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Write-back from the settings page / extension runtime: patch merges
 * field-by-field into the keepalive section (duration/USD fields accept
 * "8m"/"$1.5" strings or numbers), invalid values skip that field (the
 * section keeps its current value), then it is normalized, persisted, and the
 * effective probe config returned. The section's injection switch enabled is
 * never touched on this path (managed by writeKeepaliveEnabled). Extension
 * instances only read from disk at session creation — writes only affect
 * sessions created afterwards.
 */
export function writeKeepaliveConfig(patch: Record<string, unknown>): ProbeConfig {
  const next: Record<string, unknown> = { ...readSection() };
  if (patch.mode === "smart" || patch.mode === "default") next.mode = patch.mode;
  if (Array.isArray(patch.targets)) {
    // Filter items to non-empty strings then dedupe (keepalive model pill add/remove goes through the same path)
    next.targets = [...new Set(patch.targets.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
  }
  const duration = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? Math.round(v)
      : typeof v === "string"
        ? parseDurationMs(v)
        : null;
  const interval = duration(patch.intervalMs);
  if (interval !== null) next.intervalMs = Math.max(MIN_INTERVAL_MS, interval);
  if (patch.maxIdleMs === 0 || patch.maxIdleMs === "0") next.maxIdleMs = 0;
  else {
    const maxIdle = duration(patch.maxIdleMs);
    if (maxIdle !== null) next.maxIdleMs = maxIdle;
  }
  const int = (v: unknown, min: number, cap: number): number | null => {
    const n =
      typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), cap) : null;
  };
  const minPromptTokens = int(patch.minPromptTokens, 0, 1_000_000);
  if (minPromptTokens !== null) next.minPromptTokens = minPromptTokens;
  const maxOutputTokens = int(patch.maxOutputTokens, 1, 4096);
  if (maxOutputTokens !== null) next.maxOutputTokens = maxOutputTokens;
  const maxMissStreak = int(patch.maxMissStreak, 1, 100);
  if (maxMissStreak !== null) next.maxMissStreak = maxMissStreak;
  const maxErrorStreak = int(patch.maxErrorStreak, 1, 100);
  if (maxErrorStreak !== null) next.maxErrorStreak = maxErrorStreak;
  const usd =
    typeof patch.spendCapUsd === "number" && Number.isFinite(patch.spendCapUsd) && patch.spendCapUsd >= 0
      ? patch.spendCapUsd
      : typeof patch.spendCapUsd === "string"
        ? parseUsd(patch.spendCapUsd)
        : null;
  if (usd !== null) next.spendCapUsd = usd === 0 ? null : usd;
  // Persist with all fields normalized (read-path normalized values are pinned
  // so no dirty values linger in the section);
  // enabled is the injection switch, passed through from the section's current
  // value; the parameter path must not change it.
  // probeEnabled is a leftover key of the removed probe switch; sweep it out
  // of the section while here
  delete next.probeEnabled;
  const config = normalizeProbeConfig(next);
  writeSection({ ...next, ...config });
  return config;
}
