// Throwaway smoke for the judge-gated title refresh: settings frame fields,
// set_session_title_refresh prompts write, and the refresh hook surviving real
// prompt rounds on the test profile. Delete after the feature lands.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-title-refresh.ts
import { smokeEnv, profileAgentPath } from "./smoke-profile.ts";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let child: ReturnType<typeof spawn> | null = null;
const fail = (msg: string): never => {
  console.error("✗ " + msg);
  if (child?.pid) child.kill("SIGTERM");
  process.exit(1);
};

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: smokeEnv(),
  stdio: ["ignore", "pipe", "inherit"],
});
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("host 30s not ready")), 30_000);
  child!.stdout!.setEncoding("utf8");
  child!.stdout!.on("data", function onLine(chunk) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      resolve(m[1]);
    }
  });
}).catch((e) => fail(String(e)));
console.log("host ready:", wsUrl);

const ws = new WebSocket(wsUrl);
setTimeout(() => fail("90s: assertions incomplete"), 90_000);

let stage = 0;
let sessionId = "";
const desktopJson = () => JSON.parse(readFileSync(profileAgentPath("omp-desktop.json"), "utf8"));
function finish(): void {
  // Leave the switch off so repeated runs start clean.
  ws.send(JSON.stringify({ type: "set_session_title_refresh", enabled: false }));
  setTimeout(() => {
    child?.kill("SIGTERM");
    console.log("\nsmoke passed: 4 assertions");
    process.exit(0);
  }, 1500);
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "ready") {
    ws.send(JSON.stringify({ type: "reload_settings" }));
    return;
  }
  if (msg.type === "settings") {
    const hs = msg.settings ?? msg;
    if (stage === 0) {
      const opts = hs.sessionTitleRefreshOptions?.join(",");
      if (opts === "1,3,5,10" && typeof hs.sessionTitleRefreshPrompts === "number") {
        console.log("✓ settings frame carries prompts/options");
      } else {
        fail(`settings frame missing fields: opts=${opts}`);
      }
      stage = 1;
      ws.send(JSON.stringify({ type: "set_session_title_refresh", enabled: true, prompts: 3 }));
      return;
    }
    if (stage === 1) {
      const cfg = desktopJson().sessionTitles ?? {};
      if (cfg.refresh === true && cfg.refreshPrompts === 3) console.log("✓ omp-desktop.json written (refresh+prompts)");
      else fail(`omp-desktop.json mismatch: ${JSON.stringify(cfg)}`);
      stage = 2;
      ws.send(JSON.stringify({ type: "create_session" }));
      return;
    }
  }
  if (msg.type === "session_created" && !sessionId) {
    sessionId = msg.sessionId;
    console.log("✓ session created " + sessionId.slice(0, 8));
    // The prompt RPC runs noteTitlePrompt synchronously; the model turn itself
    // needs live credentials, so the assertion is the pipeline not throwing:
    // probe the host with reload_settings right after the prompt round-trips.
    ws.send(JSON.stringify({ type: "prompt", sessionId, text: "Reply with the single word: pong" }));
    setTimeout(() => ws.send(JSON.stringify({ type: "reload_settings" })), 1500);
    return;
  }
  if (msg.type === "settings" && stage === 2) {
    console.log("✓ prompt round-trip survived the drift-counter hook");
    finish();
  }
};

ws.onerror = (e) => fail("ws error: " + String(e));
