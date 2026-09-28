/**
 * 缓存保活配置域（pi-kimi-keepalive a05bafd / v0.3.8 移植自有化的桌面适配层）。
 *
 * 上游把探测参数放 ~/.omp/cache-keepalive/state.json（全局一份、与 CLI 共享）；
 * 桌面移植版按用户要求改为 omp-desktop.json 的 keepalive 段——随 profile 天然
 * 独立（H.desktopProjectsPath 即当前 profile 的 agent 目录）。段内唯一开关：
 *   enabled 本应用是否注入扩展并探测（session-lifecycle 消费，缺省 false；
 *           开=探测开，桌面域不设第二层探测开关——注入即用户显式付费确认，
 *           与上游 config.enabled 两层语义不同）
 * probe-log.jsonl 审计日志仍在 ~/.omp/cache-keepalive/（只追加、无配置语义）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { H } from "./state.ts";

export const STATE_DIR = join(homedir(), ".omp", "cache-keepalive");
export const PROBE_LOG_FILE = join(STATE_DIR, "probe-log.jsonl");

/** 单次探测请求的兜底超时。 */
export const PROBE_TIMEOUT_MS = 30_000;
/** 探测节奏下限（上游 CLI 命令层同款约束：30s）。 */
export const MIN_INTERVAL_MS = 30_000;

export interface ProbeConfig {
  /** 保活目标模型（catalog id "provider/model"，空 = 不探测任何模型）。
   *  上游硬编码 kimi-code；桌面版按用户要求泛化为可选模型列表。 */
  targets: string[];
  intervalMs: number;
  /** 0 = 永不因空闲停止。 */
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

// ---------- omp-desktop.json keepalive 段原子读写 ----------

/** 读 omp-desktop.json 全量（缺文件/损坏回空对象——与 profile.ts 同容错）。 */
function readDesktopJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 读 keepalive 段（无段/非法回空对象）。 */
function readSection(): Record<string, unknown> {
  const section = readDesktopJson().keepalive;
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** 合并写 keepalive 段，保留 omp-desktop.json 其他键与段内未提及字段。 */
function writeSection(section: Record<string, unknown>): void {
  const raw = readDesktopJson();
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, keepalive: section }, null, 2));
}

// ---------- 注入开关（enabled） ----------

/** 本应用是否注入缓存保活扩展（omp-desktop.json 的 keepalive.enabled，缺省关）。 */
export function readKeepaliveEnabled(): boolean {
  return readSection().enabled === true;
}

/** 写回 keepalive.enabled。 */
export function writeKeepaliveEnabled(enabled: boolean): void {
  writeSection({ ...readSection(), enabled });
}

// ---------- 探测参数（数值字段；启停由段内唯一开关 enabled 承担） ----------

/**
 * 归一化（钳制逻辑自上游 readConfigFromDisk 保真迁移）：非法/缺失值钳回缺省。
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

/** 扩展加载时的当前探测配置（设置帧同源；无段时给缺省值）。 */
export function readKeepaliveProbeConfig(): ProbeConfig {
  return normalizeProbeConfig(readSection());
}

/**
 * Parse "90s" | "4m" | "1h30m" | "2.5m" | bare minutes. Returns ms or null.
 * 上游 lib.ts 原版恢复 + 补齐复合段：上游 HELP 文案承诺 "4m45s" 写法但原正则
 * 只收单段（上游自身不一致），UI fmtDur 也产复合格式，此处一并支持。
 */
export function parseDurationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  if (/^\d+$/.test(text)) {
    // bare number = minutes（上游语义）
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

/** Parse "$1.5" | "1.5" into USD, or null.（上游 lib.ts 原样恢复） */
export function parseUsd(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d+)?$/.test(text))
    return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 设置页/扩展运行时写回：patch 与 keepalive 段逐字段合并（duration/USD 字段接受
 * "8m"/"$1.5" 字符串或数字），非法值忽略该字段（保持段内原值），归一化后落盘
 * 并返回生效探测配置。段内注入开关 enabled 不在此路径触碰（由
 * writeKeepaliveEnabled 管理）。扩展实例只在会话创建时读盘——写入只影响此后
 * 创建的会话。
 */
export function writeKeepaliveConfig(patch: Record<string, unknown>): ProbeConfig {
  const next: Record<string, unknown> = { ...readSection() };
  if (patch.mode === "smart" || patch.mode === "default") next.mode = patch.mode;
  if (Array.isArray(patch.targets)) {
    // 逐项过滤为非空字符串再去重（保活模型胶囊添加/删除走同一路径）
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
  // 全字段归一化落盘（读路径归一化的值固化，段内不再滞留脏值）；
  // enabled 是注入开关，从 section 原值透传，参数路径不得改动。
  // probeEnabled 是已移除的探测开关残留键，顺手清出段外
  delete next.probeEnabled;
  const config = normalizeProbeConfig(next);
  writeSection({ ...next, ...config });
  return config;
}
