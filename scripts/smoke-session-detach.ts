// Session detach smoke: the frontend's LRU eviction signal (mcp_detach) must drop the
// socket from the session's fan-out set without touching the pool, and reopening the
// session must re-attach it. Without the detach the host counts the evicted session as
// watched forever, so idle eviction never reclaims it and it stays in the sidebar's
// active-tasks list for as long as the window is open.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-session-detach.ts [host ws url]
// Zero model calls; spawns its own host when no address is given and deletes the session
// files it created on exit.
import { smokeEnv } from "./smoke-profile.ts";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const args = process.argv.slice(2);
let child: ReturnType<typeof spawn> | null = null;
let wsUrl = args[0];
const createdFiles: string[] = [];

function cleanup() {
  if (child?.pid) child.kill("SIGTERM");
  for (const p of createdFiles) {
    void rm(p, { force: true });
    void rm(p.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  }
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  cleanup();
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    env: smokeEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  });
  wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
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
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl!);
const watchdog = setTimeout(() => fail("60s 内未完成全部断言"), 60_000);

let stage: "create" | "wait-detach" | "reopen" = "create";
let sessionPath = "";
let sessionId = "";
const poolFrames: { path: string }[][] = [];

ws.onmessage = async (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "pool_sessions") poolFrames.push(msg.sessions ?? []);
  switch (msg.type) {
    case "ready":
      ws.send(JSON.stringify({ type: "create_session" }));
      break;
    case "session_created":
      if (stage === "create") {
        sessionPath = msg.path;
        sessionId = msg.sessionId;
        createdFiles.push(sessionPath);
        console.log(`会话建立: ${sessionId.slice(0, 8)}`);
        ws.send(JSON.stringify({ type: "list_sessions" })); // pool_sessions rides along
      } else {
        if (msg.sessionId !== sessionId) fail(`重开后拿到了另一个会话: ${msg.sessionId}`);
        console.log("重开后重新挂载成功，会话 id 一致");
        console.log("✓ 全部通过");
        clearTimeout(watchdog);
        cleanup();
        process.exit(0);
      }
      break;
    case "session_list":
      if (stage === "create") {
        const inPool = poolFrames[poolFrames.length - 1]?.some((s) => s.path === sessionPath);
        if (!inPool) fail("建会话后 pool_sessions 应包含它");
        stage = "wait-detach";
        ws.send(JSON.stringify({ type: "mcp_detach", path: sessionPath }));
        await Bun.sleep(300);
        ws.send(JSON.stringify({ type: "list_sessions" }));
      } else if (stage === "wait-detach") {
        const still = poolFrames[poolFrames.length - 1]?.some((s) => s.path === sessionPath);
        if (!still) fail("detach 只释放观看关系，会话应仍在内存池中");
        console.log("detach 后池快照仍持有该会话（槽位已释放，等空闲逐出）");
        stage = "reopen";
        ws.send(JSON.stringify({ type: "load_session", path: sessionPath }));
      }
      break;
    default:
      break;
  }
};
