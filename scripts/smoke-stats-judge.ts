// Smoke: the desktop host registers the stats judge (host/stats-judge.ts).
// Spawns a test-profile host and asserts the frustration dashboard can classify
// messages: omp-stats only judges when the hosting process registers a judge,
// so a host that never registers one leaves every rate on the regex fallback
// and the dashboard's judge button permanently disabled.
//  - GET /api/stats/frustration -> judgeAvailable is true
//  - GET /api/frustration/estimate -> answers with a judge quote (a 200 with
//    the available flag), i.e. the provider resolves
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-stats-judge.ts
import { smokeEnv } from "./smoke-profile.ts";
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
  env: smokeEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr!.setEncoding("utf8");
child.stderr!.on("data", (chunk: string) => {
  process.stderr.write(chunk);
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

// The judge is registered during profile init, which runs after the READY
// line — poll until the dashboard reports the provider.
let judgeAvailable = false;
for (let i = 0; i < 60 && !judgeAvailable; i++) {
  const res = await fetch(`${base}/api/stats/frustration?range=24h`);
  const body = (await res.json()) as { judgeAvailable?: boolean };
  judgeAvailable = body.judgeAvailable === true;
  if (!judgeAvailable) await Bun.sleep(500);
}
assert(judgeAvailable, "stats dashboard reports judgeAvailable");

const estimate = await fetch(`${base}/api/frustration/estimate?range=24h`);
assert(estimate.status === 200, "estimate endpoint answers 200");
const quote = (await estimate.json()) as { available?: boolean; reason?: string };
assert(typeof quote.available === "boolean", "estimate payload carries the available flag");
console.log("    estimate:", JSON.stringify(quote));

clearTimeout(failTimeout);
child.kill("SIGTERM");
console.log("\nALL PASS");
