// Bun host process: a multi-session container for the library-embedded omp
// SDK (modeled after etower-agent's session pool).
// This file is the host body, dynamically loaded by the thin entry host.ts
// in the zero-arg form (argv routing: see host.ts).
//
// Process model:
// - The process-level base is assembled once (authStorage / modelRegistry /
//   settings) and injected per session (bootstrap.ts + profile.ts)
// - Each session = one in-process AgentSession + a private AgentRegistry
//   (mandatory for multiple concurrent top-level agents)
// - Sessions live under a dedicated profile, isolated from the user CLI's
//   ~/.omp/agent; the profile reuses the old RPC version's auth (agent.db)
// - The UI shell connects over WebSocket: commands (119 RPCs, the eleven domain
//   handler tables in host/rpc/) + a narrow event stream
// - The first stdout line prints `READY ws://127.0.0.1:<port>`, read by the
//   Tauri shell and relayed to the frontend
//
// This file keeps only: the startup prologue (profile assembly), the WS
// server shell (ready frame + RPC dispatch), and host-level background tasks
// (quota refresh / external-write detection / watchdog / orphan self-healing).
// Module split: bootstrap.ts (SDK load gate) / state.ts (shared state and push
// bridge) / profile.ts (profile·env·toggles) / frames.ts (models/settings
// frame assembly) / session-lifecycle.ts (session lifecycle and event wiring) /
// plan.ts · goal.ts · queue.ts (domain logic) / translate.ts (omp events →
// narrow events) / rpc/ (nine RPC handler domains) / assets.ts ·
// extensions.ts · models.ts · stats.ts · limits/ · mcp-pool.ts · mcp-mount.ts · pty.ts ·
// session-poll.ts (pooled-session file polling).
import { initialProfile } from "./bootstrap.ts";
import { H, sessions, eachUiWs } from "./state.ts";
import { hostI18n } from "./i18n/host.ts";
import { applyProfile, refreshAvailableProfiles } from "./profile.ts";
import { modelsFrame } from "./frames.ts";
import { handleStatsHttp } from "./stats.ts";
import { closeAllSharedMcpConnections } from "./mcp-pool.ts";
import { startSessionPoll } from "./session-poll.ts";
import { refreshAllLimits } from "./limits/index";
import { augmentGuiPath } from "./gui-path.ts";
import { startBrowserMirror } from "./browser-mirror.ts";
import { makeWsHandlers } from "./ws-shared.ts";
import { readRemoteConfig, setRemoteWsHandlers, startRemoteServer } from "./remote.ts";
import { safeStderr } from "./stderr.ts";

// ---------- Startup prologue: activate the persisted profile, assemble the process-level base ----------
// PATH augment completion point: the first RPC after UI connects
// (list_agent_assets → MCP health probes) already spawns subprocesses, so it
// must complete before that. host.ts fired it early, overlapping the SDK
// static graph load — usually zero wait here.
await augmentGuiPath();
// Profile init does not wait for online model catalog discovery
// (refreshInBackground inside applyProfile); the ready frame carries the
// disk-cached catalog and is immediately usable. Once the background refresh
// completes, a catch-up models frame is pushed via onModelsRefreshed.
H.onModelsRefreshed = () => {
  eachUiWs((ws) => ws.send(JSON.stringify(modelsFrame())));
};
const profileReady = (async () => {
  H.currentProfile = initialProfile;
  await refreshAvailableProfiles();
  await applyProfile(H.currentProfile);
})();
profileReady.catch((err) => {
  safeStderr(hostI18n.t("errors.host.profileInitFailed", { detail: err instanceof Error ? err.stack ?? err.message : String(err) }));
  process.exitCode = 1;
});

// ---------- WebSocket server ----------
// open/message/close are shared with the LAN remote server (host/remote.ts) —
// one handler set, protocol identical for both (spec §3.3/§3.4).
const wsHandlers = makeWsHandlers(profileReady);
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // Dynamic port: a fixed one would clash when multiple workspaces run the same app in parallel
  async fetch(req, srv) {
    if (srv.upgrade(req)) return;
    const statsRes = await handleStatsHttp(req, srv);
    if (statsRes) return statsRes;
    return new Response("websocket only", { status: 400 });
  },
  websocket: wsHandlers,
});

// ---------- LAN remote server (spec §3): autostart after profileReady when remote.enabled ----------
setRemoteWsHandlers(wsHandlers);
void profileReady.then(() => {
  const cfg = readRemoteConfig();
  if (!cfg.enabled) return;
  const r = startRemoteServer(cfg.port);
  if (!r.ok) safeStderr(`[remote] autostart failed: ${r.error}\n`);
});

// Agent browser live mirror: poll the SDK tab registry for the UI's auto-open
// signal + screencast subscription (host/browser-mirror.ts).
startBrowserMirror();

process.on("SIGTERM", async () => {
  // Tauri shell exit fallback; dispose triggers the persistence wind-down
  await Promise.allSettled([...sessions.values()].map((e) => e.session.dispose()));
  await closeAllSharedMcpConnections();
  process.exit(0);
});

// Parent-death self-monitor: when tauri dev kills the process tree, the
// shell's Exit callback may not get to kill us in time. The host polls its
// ppid and exits itself once the parent is gone, precluding orphan processes.
// The exit is a hard SIGKILL, not process.exit(0): a normal exit fires the
// SDK's process-exit hook, which appends a session_exit entry to every open
// session's journal — and during a host-overlap window (shell restart, two
// app instances) those sessions are already owned by the successor host, so
// that append forks the whole journal into duplicate session files
// (2026-10-05 triple-session incident). SIGKILL skips all JS teardown: zero
// journal writes, zero forks. Journal appends are synchronously durable per
// write, so the only thing lost is this process's exit diagnostic entry —
// and this path only runs when the shell is already gone.
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(0); // SIGKILL self-kill unavailable: fall back to a normal exit
    }
  }
}, 2000);

// ---------- Host memory watchdog ----------
// Runaway sessions / cache buildup can push host RSS to consume the whole
// machine's memory. Bun/JSC has no usable heap cap switch (BUN_JSC_forceRAMSize
// measured as ineffective), so fall back to RSS polling: past the limit, log
// and exit with code 86. The Tauri shell recognizes 86 and rate-limitedly
// restarts the host (src-tauri/src/lib.rs); the frontend retry loop reconnects
// to the new WS port automatically and disk sessions are unaffected. Normal
// usage stays far below the threshold — this is only a runaway fallback.
const HOST_RSS_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss > HOST_RSS_LIMIT_BYTES) {
    safeStderr(hostI18n.t("errors.host.rssOverLimit", { mb: (rss / 1048576) | 0 }));
    process.exit(86);
  }
}, 30_000);

console.log(`READY ws://127.0.0.1:${server.port}`);
safeStderr(hostI18n.t("errors.startup.timingWsReady", { ms: performance.now().toFixed(0) }));

// Background quota refresh: at startup, preloads every configured provider
// (any provider that has appeared in the model catalog), then re-pulls all
// accounts every 5 minutes; cache TTL is likewise 5min, so foreground
// hover/page switches always hit the cache, and the real request rate to
// providers strictly equals this cadence.
const LIMITS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function configuredLimitProviders() {
  const seen = new Map<string, string>();
  for (const m of H.availableModels) {
    if (seen.has(m.provider)) continue;
    let baseUrl = "";
    try {
      baseUrl = H.modelRegistry.getProviderBaseUrl(m.provider) ?? "";
    } catch {}
    seen.set(m.provider, baseUrl);
  }
  return [...seen].map(([id, baseUrl]) => ({ id, baseUrl }));
}
const runLimitsRefresh = () => {
  const providers = configuredLimitProviders();
  void refreshAllLimits(H.authStorage, providers).then(() => {
    safeStderr(hostI18n.t("errors.host.quotaRefreshDone", { providers: providers.length }));
  });
};
void profileReady.then(runLimitsRefresh);
setInterval(() => {
  void profileReady.then(runLimitsRefresh);
}, LIMITS_REFRESH_INTERVAL_MS);

// ---------- Host pooled-session file polling (moved to session-poll.ts) ----------
startSessionPoll();
