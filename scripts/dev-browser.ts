// Browser dev harness: spawns the Bun host + Vite dev server and prints the URL that
// connects the browser UI to the REAL host:
//
//   BROWSER_URL=http://localhost:<vite>/?ws=<hostWsPort>
//
// The ?ws= branch (ui-src/store/ws.ts) makes the UI skip the Tauri ws_url lookup and open
// the host's main WS server directly — the full local channel (no remote stamp, no write
// denylist) with Vite HMR. Unlike ?preview=1 (sample data, no host) and unlike the remote
// LAN server (built ui/dist, REMOTE_WRITE_DENYLIST-gated).
//
// Profile: defaults to omp-desktop-dev (AGENTS.md profile isolation); an explicit
// OMP_PROFILE in the environment wins.
//
// Port strategy: the host WS port is dynamic (its READY line tells us). Vite's port is
// picked HERE (bind :0, release, then --strictPort) instead of parsed from its banner —
// a stale Vite already squatting on 5173 (leftover tab servers survive) makes
// auto-increment output unreliable to parse through the spawn chain, and a known port
// needs no parsing at all: readiness is the port answering HTTP. A lost bind race fails
// loudly via strictPort and tears the harness down.
//
// Concurrency: two instances never fight over ports — but they must NOT share one
// OMP_PROFILE (the session pool is per-host in-memory, the automations scheduler would
// fire twice and omp-desktop.json writes would race). Give a second instance its own
// OMP_PROFILE.
//
// Shutdown: SIGINT/SIGTERM or either child dying kills the whole tree (taskkill /T on
// Windows — Vite spawns worker processes of its own).
import { spawn, type ChildProcess } from "node:child_process";

const HOST_READY = /READY ws:\/\/127\.0\.0\.1:(\d+)/;
const READY_TIMEOUT_MS = 60_000;

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, OMP_PROFILE: process.env.OMP_PROFILE ?? "omp-desktop-dev" };

// Bind :0 to learn a free port, release it, hand it to Vite with strictPort.
const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
const vitePort = probe.port;
probe.stop(true);
if (!vitePort) throw new Error("[dev-browser] probe server reported no port");

const host = spawn("bun", ["host/host.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] });
// Direct vite binary (no `bun run` middleman); logs flow straight to this terminal.
// --host 127.0.0.1: kills the Windows localhost IPv4/IPv6 split (Bun's fetch probes and
// Vite's listen would otherwise resolve different stacks and the readiness probe never
// sees the server up).
const vite = spawn("bun", ["node_modules/vite/bin/vite.js", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], {
  cwd: root,
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

let shuttingDown = false;
function killTree(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [host, vite]) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    // Windows: kill() only reaches the direct child; taskkill /T takes the whole tree
    // (Vite's esbuild/worker children included).
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    }
  }
}
process.on("SIGINT", () => {
  killTree();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killTree();
  process.exit(143);
});

for (const [child, name] of [
  [host, "host"],
  [vite, "vite"],
] as const) {
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[dev-browser] ${name} exited (code ${code}) — tearing down`);
    killTree();
    process.exit(1);
  });
}

// Host readiness: first stdout line is READY ws://127.0.0.1:<port> (host/main.ts — the
// Tauri shell parses the same line in release runs). Rejects on early exit or timeout.
function waitHostPort(child: ChildProcess): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buf = "";
  const timer = setTimeout(() => {
    child.stdout!.off("data", onData);
    reject(new Error(`host not ready within ${READY_TIMEOUT_MS / 1000}s`));
  }, READY_TIMEOUT_MS);
  const onData = (chunk: string) => {
    buf += chunk;
    const m = buf.match(HOST_READY);
    if (m) {
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      resolve(m[1]);
    }
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", onData);
  child.on("exit", () => {
    clearTimeout(timer);
    reject(new Error(`host exited before printing its READY line:\n${buf.slice(-2000)}`));
  });
  return promise;
}

// Vite readiness: the known port answering HTTP (strictPort + picked port ⇒ the
// responder can only be our own server).
async function waitViteOk(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`vite not ready within ${READY_TIMEOUT_MS / 1000}s`);
    await Bun.sleep(300);
  }
}

const [hostPort] = await Promise.all([waitHostPort(host), waitViteOk(vitePort)]).catch((err) => {
  console.error(`[dev-browser] startup failed: ${err instanceof Error ? err.message : err}`);
  killTree();
  process.exit(1);
});
console.log(`BROWSER_URL=http://127.0.0.1:${vitePort}/?ws=${hostPort}`);
