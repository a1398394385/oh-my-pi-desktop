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
// extensions.ts · models.ts · stats.ts · limits/ · mcp-pool.ts · mcp-mount.ts · pty.ts.
import { stat, open } from "node:fs/promises";
import { initialProfile } from "./bootstrap.ts";
import { H, sessions, HOST_INSTANCE_ID } from "./state.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";
import { applyProfile, refreshAvailableProfiles } from "./profile.ts";
import { modelsPayload, modelsDefaults, modelRolesPayload } from "./models.ts";
import { settingsFrame, modelsFrame } from "./frames.ts";
import { dispatchRpc } from "./rpc/index";
import { disposeTerminalsOf } from "./pty.ts";
import { closeAllSharedMcpConnections } from "./mcp-pool.ts";
import { refreshAllLimits } from "./limits/index.ts";
import { augmentGuiPath } from "./gui-path.ts";
import { settingsGet } from "./settings-compat.ts";
import { browserMirrorOnWsClose, browserMirrorOnWsOpen, startBrowserMirror } from "./browser-mirror.ts";
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
const activeWs: { value: unknown } = { value: null };
H.onModelsRefreshed = () => {
  const ws = activeWs.value as { send(data: string): unknown } | null;
  if (ws) ws.send(JSON.stringify(modelsFrame()));
};
const profileReady = (async () => {
  H.currentProfile = initialProfile;
  await refreshAvailableProfiles();
  await applyProfile(H.currentProfile);
})();
profileReady.catch((err) => {
  safeStderr(`[host] Profile 初始化失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});

// ---------- WebSocket server ----------
const server = Bun.serve<{ sessionId: string | null }>({
  port: 0, // Dynamic port: a fixed one would clash when multiple workspaces run the same app in parallel
  async fetch(req, srv) {
    if (srv.upgrade(req)) return;
    const statsRes = await handleStatsHttp(req, srv);
    if (statsRes) return statsRes;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      browserMirrorOnWsOpen(ws);
      safeStderr(`[host] WS 客户端接入（前端加载与连接全链路 OK） [t=${performance.now().toFixed(0)}ms]\n`);
      void profileReady.then(
        () => {
          ws.send(
            JSON.stringify({
              type: "ready",
              hi: HOST_INSTANCE_ID, // The handshake takes no event seq, but carries instance identity for immediate UI comparison
              approvalMode: settingsGet(H.settings, "tools.approvalMode"),
              models: modelsPayload(),
              roles: modelRolesPayload(),
              ...modelsDefaults(),
              settings: settingsFrame(),
            }),
          );
        },
        (err) => {
          ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        },
      );
    },
    async message(ws, raw) {
      let msg: any;
      try {
        await profileReady;
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.initFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
        return;
      }
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.host.invalidJson") }));
        return;
      }
      try {
        await dispatchRpc(ws, msg);
      } catch (err) {
        // A single failed command must not take down the host; report the error to the frontend as-is
        ws.send(JSON.stringify({ type: "error", sessionId: msg.sessionId ?? null, kind: msg.kind ?? null, message: String(err) }));
        safeStderr(`[host] 命令 ${msg.type} 失败: ${err}\n`);
      }
    },
    close(ws) {
      // Frontend disconnected: dispose its terminal PTYs to prevent orphan shell processes
      if (activeWs.value === ws) activeWs.value = null;
      browserMirrorOnWsClose(ws);
    },
  },
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
    safeStderr(`[host] RSS ${(rss / 1048576) | 0}MB 超上限 2048MB，主动退出等待壳重启\n`);
    process.exit(86);
  }
}, 30_000);

console.log(`READY ws://127.0.0.1:${server.port}`);
safeStderr(`[host][启动计时] WS 服务就绪 [t=${performance.now().toFixed(0)}ms]\n`);

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
    safeStderr(`[host] 配额预载/刷新完成: ${providers.length} 个供应商\n`);
  });
};
void profileReady.then(runLimitsRefresh);
setInterval(() => {
  void profileReady.then(runLimitsRefresh);
}, LIMITS_REFRESH_INTERVAL_MS);

// ---------- Host pool external-write detection ----------
// Pooled sessions = the full set desktop currently holds in memory (the host
// pool is unbounded; the frontend's OPEN_SESSIONS_MAX only governs UI LRU).
// The lock file carries no signal (.lock.os is an advisory leftover, the
// publish hold window is <500ms); the only reliable signal is the file being
// appended by a process other than ours: read the new complete lines from
// pollKnownSize onward — an id not present in the manager's in-memory index
// means an external write (CLI conversation/rename/compact all persist new
// entries). Ids we wrote ourselves always pass through memory first, so zero
// false positives.
const POLL_EXTERNAL_WRITES_MS = 2000;
async function pollExternalWrites() {
  for (const [sessionId, entry] of sessions.entries()) {
    try {
      const st = await stat(entry.path);
      if (st.size === entry.pollKnownSize) continue;
      if (st.size < entry.pollKnownSize) entry.pollKnownSize = 0; // Full rewrite: rescan from the start
      const fh = await open(entry.path, "r");
      let data: Buffer;
      try {
        data = Buffer.alloc(st.size - entry.pollKnownSize);
        const { bytesRead } = await fh.read(data, 0, data.length, entry.pollKnownSize);
        data = data.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      // Consume up to the last complete line only (partial lines wait for the next poll, avoiding half-written JSON)
      let lineEnd = -1;
      for (let i = 0; i < data.length; i++) if (data[i] === 10) lineEnd = i;
      if (lineEnd < 0) continue;
      const newIds: string[] = [];
      let lineStart = 0;
      while (lineStart <= lineEnd) {
        const nl = data.indexOf(10, lineStart);
        const line = data.subarray(lineStart, nl).toString("utf8");
        lineStart = nl + 1;
        if (line.trim()) {
          try {
            const o = JSON.parse(line) as { id?: unknown; type?: unknown };
            // File bookkeeping rows are excluded from the check: the header
            // (type "session", its id has sessionId shape but getEntries
            // explicitly excludes headers) and the title slot row; only real
            // entries are compared against the in-memory index
            if (typeof o.id === "string" && o.type !== "session") newIds.push(o.id);
          } catch {
            // A complete but corrupted line: skip
          }
        }
      }
      entry.pollKnownSize += lineStart;
      if (entry.externalWrite || newIds.length === 0) continue;
      const known = new Set<string>(entry.manager.getEntries().map((e: { id?: string }) => e?.id));
      if (!newIds.some((id) => !known.has(id))) continue;
      entry.externalWrite = true;
      const ws = entry.attachedWs as { send(data: string): unknown } | null;
      ws?.send(JSON.stringify({ type: "session_external_write", sessionId }));
    } catch (err) {
      // New session files are lazily persisted (created on the first entry): ENOENT = nothing to monitor yet, skip silently
      if ((err as { code?: string }).code === "ENOENT") continue;
      safeStderr(`[host] 外部写入轮询失败 ${entry.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
setInterval(() => { void pollExternalWrites(); }, POLL_EXTERNAL_WRITES_MS);
