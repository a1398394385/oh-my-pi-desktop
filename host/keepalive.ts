/**
 * pi-kimi-keepalive desktop port (self-owned port of src/index.ts from
 * https://github.com/realOliverSama/pi-kimi-keepalive a05bafd / v0.3.8,
 * iterated in this repo afterwards).
 *
 * Mechanism: before_provider_request read-only captures the last full real
 * kimi-code request (including cache_control markers); when the session goes
 * idle, the captured request is replayed as a tiny non-streaming call —
 * max_tokens clamped to 16, thinking/stream stripped, tool_choice:none (one
 * downgraded retry on 400) — with the session prefix byte-for-byte unchanged,
 * so the vendor's automatic prefix cache treats it as a continuation and
 * restarts the TTL at cache-read prices. Probes never enter the session
 * stream (no synthetic messages/tool calls; only aggregate stats and the
 * probe-log are persisted).
 *
 * Guardrails: skip while the agent is busy, stop after maxidle, circuit-break
 * on consecutive cache misses / network errors, stop immediately on auth
 * failure, stop when the session spend cap is reached; a fresh real request
 * always re-arms and clears the sticky pause.
 *
 * Cut relative to upstream (desktop hasUI=false, these paths are unreachable
 * inside the desktop host):
 *   - runSetupWizard (TUI first-run wizard, depends on pi.ui.input/confirm)
 *   - pi.registerCommand("/keepalive" slash command; desktop slash commands
 *     are a separate UI-side system)
 *   - status line (pi.ui.setStatus) and statusLines reporting — desktop-side
 *     status visualization to be redone as needed later
 * The main probe chain (capture/schedule/replay/circuit-break/persist) keeps
 * upstream logic line by line.
 * Config source of truth: the keepalive section of omp-desktop.json
 * (per-profile, see keepalive-config.ts; upstream state.json is kept only for
 * the probe-log audit log). Only cadence fields are written back at runtime.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { CostPerM, ParsedUsage, ProbeDialect } from "./keepalive-lib.ts";
import {
  buildProbeBody,
  buildProbeHeaders,
  estimateProbeSpendUsd,
  estimateSavedUsd,
  formatDuration,
  formatUsd,
  isCacheMiss,
  parseUsage,
  parseUsageFromSse,
  resolveProbeDialect,
} from "./keepalive-lib.ts";
import {
  DEFAULT_FALLBACK_MS,
  DEFAULT_PROBE_CONFIG,
  PROBE_LOG_FILE,
  PROBE_TIMEOUT_MS,
  STATE_DIR,
  SMART_BASE_MS,
  SMART_CONFIRM_HITS,
  SMART_MAX_CONTEXT_TOKENS,
  SMART_STEP_MS,
  readKeepaliveProbeConfig,
  writeKeepaliveConfig,
  type ProbeConfig,
} from "./keepalive-config.ts";

/** Field face of the model the captured request belongs to (narrow view of the base ExtensionContext["model"]). */
interface KeepaliveModel {
  /** catalog id ("provider/model"), the match key for targets */
  id: string;
  provider: string;
  baseUrl?: string;
  api?: string;
  cost?: Partial<CostPerM> | undefined;
}

/**
 * Narrow view of the extension event context (a structural subset of the base
 * ExtensionContext, following the inline narrow-type precedent in
 * host/acp-context.ts). The probe chain only reads these members.
 */
export interface KeepaliveContext {
  model?: KeepaliveModel | null;
  isIdle(): boolean;
  modelRegistry?: unknown;
}

/** Extension injection face: the base only requires inline extensions to attach event listeners. */
export interface KeepalivePi {
  on(event: "before_provider_request", handler: (ev: { payload: unknown }, ctx: KeepaliveContext) => void): void;
  on(event: "session_start", handler: (ev: unknown, ctx: KeepaliveContext) => void | Promise<void>): void;
  on(event: "agent_end", handler: (ev: { willContinue?: boolean }, ctx: KeepaliveContext) => void | Promise<void>): void;
  on(event: "agent_start", handler: (ev: unknown) => void | Promise<void>): void;
  on(event: "session_shutdown", handler: (ev: unknown) => void | Promise<void>): void;
}

/**
 * Request auth the host resolves for one model — the historical Pi
 * `AuthStorage` facade. oh-my-pi exposes it on the model registry, keyed by
 * model so OAuth refresh and provider-scoped header chains stay in sync with
 * real requests; hosts without it fall back to the captured headers.
 */
interface HostRequestAuth {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

/**
 * Resolve the probe's request auth from the host credential store. The model
 * captured with the payload is used, so a later model switch in the session
 * cannot resolve another provider's credentials for the probe.
 *
 * The registry is reached by capability probe, not by cast: the host may omit
 * it and must degrade to the captured headers instead of throwing.
 */
async function readRequestAuth(
  context: KeepaliveContext | null,
  model: KeepaliveModel,
): Promise<HostRequestAuth | null> {
  if (!context || !model) return null;
  const registry = context.modelRegistry;
  if (!registry || typeof registry !== "object" || !("getApiKeyAndHeaders" in registry)) return null;
  const resolve = (registry as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders;
  if (typeof resolve !== "function") return null;
  try {
    // Host-specific facade: `Function.call` erases the signature, so the shape
    // is asserted at this one boundary and read field-by-field by the caller.
    const auth = (await (resolve as (m: unknown) => Promise<unknown>).call(registry, model)) as HostRequestAuth;
    return auth;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface Capture {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  /** Model the payload was captured for; probe credentials resolve against it. */
  model: KeepaliveModel;
  provider: string;
  api: string | undefined;
  baseUrl: string;
  cost: Partial<CostPerM> | undefined;
}

interface Stats {
  probes: number;
  hits: number;
  misses: number;
  errors: number;
  savedUsd: number;
  spendUsd: number;
}

/** Host-injected extension options: isWanted = whether this session is currently worth keeping alive (an unread state maintained host-side). */
export interface KeepaliveHostOptions {
  isWanted: () => boolean;
}

/** Create the keepalive extension factory (session-lifecycle injects it conditionally on the experimental switch). */
export function createKeepaliveExtension(opts: KeepaliveHostOptions) {
  return (pi: KeepalivePi): void => {
    // ---------- mutable state ----------

    let config: ProbeConfig = { ...DEFAULT_PROBE_CONFIG };

    let ctx: KeepaliveContext | null = null;
    let capture: Capture | null = null;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextProbeAt: number | null = null;
    // Deadline suspended when a turn starts: agent_end resumes it, so a turn that
    // never touched the target model cannot push the probe out by a full interval.
    let suspendedProbeAt: number | null = null;
    // Whether the running turn captured a target-model request — only that
    // refreshes the prefix cache and so legitimately restarts the cadence.
    let targetRequestThisTurn = false;
    let lastSettledAt = Date.now();
    let inflight = false;

    let pausedReason: string | null = null;
    let missStreak = 0;
    let errorStreak = 0;
    // smart-mode runtime state (cadence itself lives in config.intervalMs, persisted)
    let smartHitStreak = 0;
    // Set when a smart-mode miss pauses probing; only re-selecting smart mode
    // clears it (a fresh real turn does NOT resume probing in this case).
    let smartPaused = false;
    const stats: Stats = { probes: 0, hits: 0, misses: 0, errors: 0, savedUsd: 0, spendUsd: 0 };

    // ---------- persistence ----------

    function persistConfig(): void {
      // Only cadence fields change at runtime (smart growth/fallback, default
      // miss backing off to 5m); all other fields belong to the settings-page
      // source of truth; write back only intervalMs to avoid concurrently
      // overwriting user edits
      try {
        writeKeepaliveConfig({ intervalMs: config.intervalMs });
      } catch (error) {
        debug("failed to persist config:", error);
      }
    }

    function isTargetModel(context: KeepaliveContext | null): boolean {
      const model = context?.model;
      // Target models are configured via the settings page targets (catalog id
      // match); upstream hardcodes kimi-code, the desktop version generalizes.
      // baseUrl must be set — the probe request hits the vendor endpoint
      // directly
      if (!model || !config.targets.includes(model.id)) return false;
      return typeof model.baseUrl === "string" && model.baseUrl.length > 0;
    }

    // ---------- scheduling ----------

    function clearTimer(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      nextProbeAt = null;
    }

    function armed(): boolean {
      // Desktop-domain single switch: the extension being injected means
      // probing (omp-desktop.json keepalive.enabled); no second-layer probe
      // switch like upstream's config.enabled anymore
      return Boolean(capture && !pausedReason && !inflight);
    }

    function schedule(delayMs?: number): void {
      clearTimer();
      if (!armed()) return;
      const delay = Math.max(1_000, delayMs ?? config.intervalMs);
      nextProbeAt = Date.now() + delay;
      timer = setTimeout(() => {
        timer = null;
        void onTick();
      }, delay);
      // A pending keepalive timer must never keep the process alive.
      if (timer && typeof (timer as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
    }

    async function onTick(): Promise<void> {
      if (!ctx || !capture) return;
      if (!opts.isWanted()) {
        // The user has already seen this session (unread cleared): stop
        // probing and clear the timer; agent_end re-arms when the next
        // completed turn produces new unread activity
        clearTimer();
        return;
      }
      if (!ctx.isIdle()) {
        // Hold the deadline instead of dropping it: agent_end resumes it, so the
        // probe fires as soon as the turn that overran it finishes.
        debug("tick skipped: agent busy; the deadline is held for agent_end");
        suspendedProbeAt = nextProbeAt ?? Date.now();
        return;
      }
      const idleFor = Date.now() - lastSettledAt;
      if (config.maxIdleMs > 0 && idleFor >= config.maxIdleMs) {
        pause(`idle for more than maxidle (${formatDuration(idleFor)})`);
        return;
      }
      await runProbe();
      if (!pausedReason) schedule();
    }

    function pause(reason: string): void {
      pausedReason = reason;
      clearTimer();
      debug(`pi-kimi-keepalive paused — ${reason}`);
    }

    // ---------- probing ----------

    function probeEndpoint(dialect: ProbeDialect): string | null {
      if (!capture) return null;
      const base = capture.baseUrl.replace(/\/+$/, "");
      if (!/^https:\/\//.test(base)) return null;
      if (dialect === "anthropic-messages") {
        // Anthropic-shaped transports serve `/v1/messages` from the base without
        // its own version segment; the host strips it before appending the same
        // path, so a `/v1`-terminated base must not become `/v1/v1/messages`.
        return `${base.replace(/\/v1\/?$/, "")}/v1/messages`;
      }
      return `${base}/chat/completions`;
    }

    /**
     * Resolve the probe's request headers. The host injects credentials after
     * any header hook fires, so captured headers usually lack auth; resolve the
     * live auth for the captured model instead — OAuth tokens refresh on real
     * requests, so a Bearer frozen at capture time can already be expired hours
     * later (HTTP 401). Falls back to the forwarded captured headers when the
     * host cannot resolve any.
     */
    async function probeHeaders(): Promise<Record<string, string> | null> {
      if (!capture) return null;
      const headers = buildProbeHeaders(capture.headers);
      const auth = await readRequestAuth(ctx, capture.model);
      if (auth?.ok) {
        if (auth.apiKey) headers.authorization = `Bearer ${auth.apiKey}`;
        for (const [key, value] of Object.entries(auth.headers ?? {})) headers[key.toLowerCase()] = value;
      } else {
        debug(
          auth === null
            ? "host exposes no request-auth resolver — falling back to captured headers"
            : `host could not resolve credentials (${auth.error ?? "unknown error"}) — falling back to captured headers`,
        );
      }
      return headers.authorization ? headers : null;
    }

    async function runProbe(): Promise<boolean> {
      if (inflight || !capture) return false;
      inflight = true;
      try {
        const dialect = resolveProbeDialect(capture.payload, capture.api);
        const endpoint = probeEndpoint(dialect);
        if (!endpoint) return false;
        for (let attempt = 1 as 1 | 2; attempt <= 2; attempt++) {
          const built = buildProbeBody(capture.payload, config.maxOutputTokens, dialect, attempt);
          if (!built.ok) {
            recordFailure(`captured payload not replayable: ${built.reason}`);
            return false;
          }
          let response: Response;
          const probeRequestHeaders = await probeHeaders();
          if (!probeRequestHeaders) {
            recordFailure("no Kimi credentials available for the probe");
            return false;
          }
          try {
            response = await fetch(endpoint, {
              method: "POST",
              headers: probeRequestHeaders,
              body: JSON.stringify(built.body),
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
          } catch (error) {
            recordFailure(`network error: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
          const text = await response.text();
          if (response.ok) {
            recordProbeResult(text);
            return true;
          }
          debug(`probe attempt ${attempt} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
          // One retry with a further-reduced terminal-parameter set when the
          // endpoint rejects the probe's extras; the conversation prefix is
          // never modified.
          const retryable = response.status === 400 && attempt === 1;
          if (!retryable) {
            recordFailure(`HTTP ${response.status}`);
            return false;
          }
        }
        return false;
      } finally {
        inflight = false;
      }
    }

    function recordProbeResult(text: string): void {
      let usage: ParsedUsage;
      try {
        usage = parseUsage(JSON.parse(text) as unknown);
      } catch {
        usage = parseUsageFromSse(text);
      }
      applyProbeUsage(usage);
    }

    function applyProbeUsage(usage: ParsedUsage): void {
      if (!capture) return;
      stats.probes += 1;
      stats.spendUsd += estimateProbeSpendUsd(usage, capture.cost);
      appendProbeLog(usage);

      if (!isCacheMiss(usage.inputTokens, usage.cacheReadTokens, config.minPromptTokens)) {
        stats.hits += 1;
        stats.savedUsd += estimateSavedUsd(usage.cacheReadTokens, capture.cost);
        missStreak = 0;
        errorStreak = 0;
        debug(
          `probe hit: cache_read=${usage.cacheReadTokens} input=${usage.inputTokens} saved=${stats.savedUsd.toFixed(4)}`,
        );
        if (config.mode === "smart") {
          smartAdaptAfterHit(usage.inputTokens);
        }
      } else {
        stats.misses += 1;
        debug(`probe miss: cache_read=0 input=${usage.inputTokens}`);
        if (config.mode === "smart") {
          smartAdaptAfterMiss();
        } else if (config.intervalMs > DEFAULT_FALLBACK_MS) {
          // Miss while probing above the safe floor: the miss probe itself
          // rebuilds the cache entry with the same prefix, so drop to the 5m
          // safe cadence (inside the nominal TTL) and keep probing — the next
          // probe renews it. Reset the streak so the new cadence gets a fresh
          // chance before a pause is considered.
          config.intervalMs = DEFAULT_FALLBACK_MS;
          missStreak = 0;
          persistConfig();
          debug(
            `cache miss — cadence backed off to ${formatDuration(config.intervalMs)} (safe TTL window); probing continues`,
          );
        } else {
          missStreak += 1;
          debug(`probe miss #${missStreak}: cache_read=0 input=${usage.inputTokens}`);
          if (missStreak >= config.maxMissStreak) {
            pause("probes stopped hitting the prefix cache; waiting for your next real turn");
          }
        }
      }

      if (
        !pausedReason &&
        config.spendCapUsd !== null &&
        stats.spendUsd >= config.spendCapUsd
      ) {
        pause(
          `probe spend ${formatUsd(stats.spendUsd)} reached the cap ${formatUsd(config.spendCapUsd)}`,
        );
      }
    }

    /**
     * smart-mode cadence adaptation.
     *
     * config.intervalMs doubles as the persisted "last confirmed cadence":
     * promotion only ever happens after SMART_CONFIRM_HITS consecutive hits, so
     * the value on disk is always one the cache has actually held for. A miss
     * steps back 30s to that last confirmed value (never below the 8m floor),
     * persists it, and pauses probing — a fresh real turn does NOT resume;
     * only re-selecting smart mode continues.
     * Contexts above 200k tokens are never pushed upward and immediately revert
     * to the floor cadence, because a miss there costs too much full-price
     * input to risk.
     */
    function smartAdaptAfterHit(inputTokens: number): void {
      if (inputTokens > SMART_MAX_CONTEXT_TOKENS) {
        // Too expensive to experiment; drop to floor and stop growing.
        if (config.intervalMs > SMART_BASE_MS) {
          config.intervalMs = SMART_BASE_MS;
          persistConfig();
          debug(
            `smart: context ${inputTokens} tokens exceeds ${SMART_MAX_CONTEXT_TOKENS / 1000}k — cadence back to the 8m floor`,
          );
        }
        smartHitStreak = 0;
        return;
      }
      smartHitStreak += 1;
      if (smartHitStreak < SMART_CONFIRM_HITS) return;
      const roomUnderMaxIdle =
        config.maxIdleMs === 0 || config.intervalMs + SMART_STEP_MS < config.maxIdleMs;
      if (roomUnderMaxIdle) {
        config.intervalMs += SMART_STEP_MS; // 3-hit-confirmed value stays on disk
        persistConfig();
        debug(
          `smart: ${smartHitStreak} consecutive hits — cadence grows to ${formatDuration(config.intervalMs)}`,
        );
      }
      smartHitStreak = 0;
    }

    function smartAdaptAfterMiss(): void {
      smartHitStreak = 0;
      const fellBack = config.intervalMs > SMART_BASE_MS;
      if (fellBack) {
        // Step back to the last confirmed cadence before pausing.
        config.intervalMs = Math.max(SMART_BASE_MS, config.intervalMs - SMART_STEP_MS);
        persistConfig();
      }
      smartPaused = true;
      pause(
        `cache miss in smart mode — cadence ${fellBack ? `back to ${formatDuration(config.intervalMs)}` : "already at the floor"}; probing stopped until smart mode is re-selected`,
      );
    }

    /**
     * Append one line per probe to ~/.omp/cache-keepalive/probe-log.jsonl so the
     * real per-probe billing (cached vs full-price tokens) can be audited after
     * the fact — the hit/miss counter alone hides partial hits, which are what
     * make a "hit" expensive on a large context.
     */
    function appendProbeLog(usage: ParsedUsage): void {
      try {
        const prompt = usage.inputTokens;
        const cached = usage.cacheReadTokens;
        const entry = {
          at: new Date().toISOString(),
          mode: config.mode,
          intervalMs: config.intervalMs,
          promptTokens: prompt,
          cachedTokens: cached,
          uncachedTokens: Math.max(0, prompt - cached),
          outputTokens: usage.outputTokens,
          hitRatio: prompt > 0 ? Number((cached / prompt).toFixed(4)) : 0,
          estUsd: Number(estimateProbeSpendUsd(usage, capture?.cost).toFixed(6)),
        };
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(PROBE_LOG_FILE, JSON.stringify(entry) + "\n");
      } catch (error) {
        debug("probe log unavailable:", error);
      }
    }

    function recordFailure(message: string): void {
      stats.errors += 1;
      errorStreak += 1;
      debug("probe failed:", message);
      if (/^HTTP 40[13]\b/.test(message)) {
        // Credentials are dead regardless of history; clear the streaks so the
        // automatic recovery after the next real turn starts from a clean slate.
        missStreak = 0;
        errorStreak = 0;
        smartHitStreak = 0;
        pause("captured credentials rejected; will recapture after your next real turn");
        return;
      }
      if (errorStreak >= config.maxErrorStreak) {
        pause(`${errorStreak} consecutive probe failures (last: ${message})`);
      }
    }

    function debug(...parts: unknown[]): void {
      if (process.env.PI_KEEPALIVE_DEBUG) {
        process.stderr.write(`[pi-kimi-keepalive] ${parts.map(String).join(" ")}\n`);
      }
    }

    // ---------- hooks ----------

    pi.on("before_provider_request", (event, requestCtx) => {
      // The host dispatches one context per provider request, carrying the model
      // that request actually uses. The session-scoped `ctx` closure is not a
      // substitute: omp issues requests for other models (tiers, subagents, small
      // utility models) inside a session whose current model is the target, and a
      // session-model check would capture those foreign payloads as Kimi's.
      if (!isTargetModel(requestCtx)) return;
      const model = requestCtx.model;
      const payload: unknown = event.payload;
      if (!model || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const raw = payload as Record<string, unknown>;
      if (!Array.isArray(raw.messages) || raw.messages.length === 0) return;
      if (raw.system !== undefined && !Array.isArray(raw.system) && typeof raw.system !== "string") return;
      let clonedPayload: Record<string, unknown>;
      try {
        clonedPayload = structuredClone(raw);
      } catch {
        // DataCloneError: the payload carries non-cloneable values (BigInt,
        // symbols, functions). Fall back to a JSON round-trip; probing never
        // mutates the captured payload, so a by-reference capture is the last
        // resort rather than failing the real request.
        try {
          clonedPayload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
        } catch {
          debug("payload not cloneable — capturing by reference");
          clonedPayload = raw;
        }
      }
      capture = {
        payload: clonedPayload,
        headers: {},
        model,
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl ?? "",
        cost: model.cost ?? undefined,
      };
      // This request refreshed the target cache, so the cadence restarts from
      // now: agent_end must not resume a deadline this turn invalidated.
      targetRequestThisTurn = true;
      // A fresh real request means fresh credentials and a warm prefix cache;
      // automatically recover from any sticky pause. Exception: a smart-mode
      // miss intentionally parks probing until the user re-selects smart mode.
      if (pausedReason !== null || missStreak > 0 || errorStreak > 0) {
        if (smartPaused) {
          if (pausedReason !== null) {
            debug("fresh real request observed — smart-mode miss pause kept; re-select smart mode to resume");
            missStreak = 0;
            errorStreak = 0;
            return;
          }
        } else {
          pausedReason = null;
          debug("fresh real request observed — keepalive unpaused");
        }
        missStreak = 0;
        errorStreak = 0;
      }
    });

    pi.on("session_start", async (_event, sessionCtx) => {
      ctx = sessionCtx;
      config = readKeepaliveProbeConfig();
      // Captures are bound to the previous session's credentials; require a new capture.
      capture = null;
      suspendedProbeAt = null;
      targetRequestThisTurn = false;
      lastSettledAt = Date.now();
      clearTimer();
    });

    pi.on("agent_end", async (event, sessionCtx) => {
      ctx = sessionCtx;
      // An automatic continuation (auto-retry, compaction, session_stop) is not
      // the settle this timer is armed against — the loop keeps running and
      // `agent_end` repeats with `willContinue` until the real one arrives. The
      // flag is host-specific, so it's probed rather than assumed.
      if ("willContinue" in event && event.willContinue === true) {
        return;
      }
      const targetTurn = targetRequestThisTurn;
      targetRequestThisTurn = false;
      lastSettledAt = Date.now();
      if (!armed()) {
        return;
      }
      if (targetTurn) {
        // The turn issued a real target-model request, which refreshed the prefix
        // cache: the cadence legitimately restarts in full.
        suspendedProbeAt = null;
        schedule();
        return;
      }
      // The turn never touched the target model, so the cache is no warmer than
      // it was: resume the suspended deadline (now, if it already passed) instead
      // of pushing the probe a whole interval out.
      const resumeAt = suspendedProbeAt;
      suspendedProbeAt = null;
      schedule(resumeAt === null ? undefined : Math.max(1_000, resumeAt - Date.now()));
    });

    pi.on("agent_start", async () => {
      // The turn both marks the session busy and, if it targets the model,
      // refreshes the cache by itself. Hold the pending deadline rather than
      // dropping it — agent_end decides whether to restart or resume the cadence.
      suspendedProbeAt = nextProbeAt;
      clearTimer();
    });

    pi.on("session_shutdown", async () => {
      clearTimer();
    });
  };
}
