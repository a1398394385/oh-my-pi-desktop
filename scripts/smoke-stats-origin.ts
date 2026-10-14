// Smoke: stats HTTP origin allowlist (host/stats.ts). Spawns a test-profile
// host and asserts CORS behavior on its /api/* endpoints (stats HTTP shares
// the dynamic WS port announced by the READY line):
//  - disallowed Origin -> no Access-Control-Allow-Origin header (the browser
//    blocks the cross-origin read; the business body itself still flows)
//  - tauri/localhost origins -> ACAO echoes the request origin
//  - no Origin header (curl-style local tools) -> passes without CORS headers
//  - OPTIONS preflight and the SSE /api/events stream follow the same rule
//  - rejected origins are logged to host stderr for misfire diagnosis
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-stats-origin.ts
import { spawn, type ChildProcess } from "node:child_process";

// Test profile isolation guard: never touch the user's default profile.
if (process.env.OMP_PROFILE !== "omp-desktop-test") {
  console.error("✗ OMP_PROFILE=omp-desktop-test required (test profile isolation)");
  process.exit(1);
}

let child: ChildProcess | null = null;

function fail(msg: string): never {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
}
const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
  else console.log("ok  " + msg);
};

// Hard overall deadline so a hung host cannot wedge the smoke forever.
const failTimeout = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderrText = "";
child.stderr!.setEncoding("utf8");
child.stderr!.on("data", (chunk: string) => {
  stderrText += chunk;
});
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("host not ready within 30s")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolve(m[1]);
    }
  });
}).catch((e) => fail(String(e)));
const base = wsUrl.replace(/^ws/, "http");
console.log("host ready:", wsUrl);

const ACAO = "access-control-allow-origin";
const EVIL = "http://evil.example";

/** GET with an optional Origin header (mimics a browser fetch or a plain local tool). */
function get(origin: string | null, path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
}

// Disallowed origin: simple GET carries no ACAO header.
{
  const res = await get(EVIL, "/api/status");
  assert(!res.headers.get(ACAO), `evil origin GET /api/status has no ACAO header (status ${res.status})`);
  await res.body?.cancel();
}

// Disallowed origin: CORS preflight gets no ACAO header either.
{
  const res = await fetch(`${base}/api/stats`, {
    method: "OPTIONS",
    headers: { "origin": EVIL, "access-control-request-method": "GET" },
    signal: AbortSignal.timeout(10_000),
  });
  assert(!res.headers.get(ACAO), `evil origin OPTIONS preflight has no ACAO header (status ${res.status})`);
  await res.body?.cancel();
}

// Allowed origins (tauri macOS/Windows + dev servers) get their origin echoed back.
for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:5173"]) {
  const res = await get(origin, "/api/status");
  assert(res.headers.get(ACAO) === origin, `allowed origin ${origin} gets ACAO echo (status ${res.status})`);
  await res.body?.cancel();
}

// No Origin header (curl-style local tools): passes without CORS headers.
{
  const res = await get(null, "/api/status");
  assert(!res.headers.get(ACAO), `no-origin GET /api/status passes (status ${res.status})`);
  await res.body?.cancel();
}

// SSE live stream follows the same rule (allowed origin echoed, evil origin denied).
{
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { "origin": "tauri://localhost" }, signal: ctl.signal });
  assert(
    res.headers.get(ACAO) === "tauri://localhost" && res.headers.get("content-type")?.includes("text/event-stream"),
    "SSE /api/events with tauri origin gets ACAO echo + event-stream",
  );
  ctl.abort();
}
{
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { "origin": EVIL }, signal: ctl.signal });
  assert(!res.headers.get(ACAO), "SSE /api/events with evil origin has no ACAO header");
  ctl.abort();
}

// Transcript trace endpoint (the named exfiltration path) follows the same rule.
{
  const res = await get(EVIL, "/api/session/trace?file=whatever.jsonl");
  assert(!res.headers.get(ACAO), `evil origin GET /api/session/trace has no ACAO header (status ${res.status})`);
  await res.body?.cancel();
}

// Rejected origins are logged to host stderr (stderr is a pipe; give it a beat to flush).
await new Promise((r) => setTimeout(r, 300));
assert(stderrText.includes(`[stats] Rejected cross-origin request with Origin: ${EVIL}`), "rejected origin logged to host stderr");

clearTimeout(failTimeout);
child.kill("SIGTERM");
console.log("\nALL PASS");
