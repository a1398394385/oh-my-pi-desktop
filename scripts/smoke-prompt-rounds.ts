// Send-path three-round smoke test: pinpoint which layer breaks on "cannot send in a historical session / on the second round".
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-prompt-rounds.ts
// Assertions cover:
//   1. Round 1 prompt in a new session -> turn_end (the create path)
//   2. Round 2 prompt in the same session -> turn_end (the sessionId path, the user-reported symptom)
//   3. After killing and restarting the host, load_session the same session -> prompt -> turn_end (the cold-load historical session path, also user-reported)
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let child: ReturnType<typeof spawn> | null = null;
const createdFiles: string[] = [];
let tmpCwd: string | null = null;

// Real-prompt smoke tests need credentials and use the default profile (existing practice, same as steer-smoke);
// list_sessions' history scan merges the tmp cwd into omp-desktop.json's allProjects,
// which must be restored before exit (including failure paths) to prevent ghost-project leftovers
const cfgPath = path.join(homedir(), ".omp/agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

function restoreCfg() {
  if (child?.pid) {
    child.kill("SIGTERM");
    child = null;
    try {
      const { execSync } = require("node:child_process");
      execSync("sleep 0.8"); // Wait for the host to finish exiting before writing back, so an exit hook cannot write the test state back
    } catch {}
  }
  try {
    if (cfgExisted) writeFileSync(cfgPath, cfgBackup!);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreCfg();
  process.exit(1);
}

async function cleanup() {
  for (const f of createdFiles) await rm(f).catch(() => {});
  if (tmpCwd) await rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
}

async function startHost(): Promise<{ child: ReturnType<typeof spawn>; wsUrl: string }> {
  const c = spawn("bun", ["host/host.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("宿主 30s 未就绪")), 30_000);
    c.stdout!.setEncoding("utf8");
    c.stdout!.on("data", function onLine(chunk: string) {
      const m = chunk.match(/READY (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        c.stdout!.off("data", onLine);
        resolve(m[1]);
      }
    });
    c.on("exit", (code) => reject(new Error(`宿主提前退出 code=${code}`)));
  });
  return { child: c, wsUrl: url };
}

function connect(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`WS 错误: ${String(e)}`));
  });
}

function ask(text: string): string {
  return `不要调用任何工具，只输出 ${text} 这几个字符然后立即结束。`;
}

tmpCwd = await mkdtemp(`${tmpdir()}/omp-prompt-rounds-`);

// ---------- Phase A: two rounds in a new session ----------
{
  const { child: c, wsUrl } = await startHost();
  child = c;
  const ws = await connect(wsUrl);
  const st = {
    sessionId: "" as string,
    path: "" as string,
    phase: 0 as 0 | 1 | 2, // 0=first round 1=second round 2=done
    gotEnd: false,
  };
  const timer = setTimeout(() => fail("阶段 A 超时（180s 未完成两轮）"), 180_000);

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    switch (msg.type) {
      case "ready":
        ws.send(JSON.stringify({ type: "create_session", cwd: tmpCwd }));
        break;
      case "session_created":
        st.sessionId = msg.sessionId;
        st.path = msg.path;
        createdFiles.push(msg.path);
        console.log(`会话建立: ${msg.sessionId.slice(0, 8)}`);
        ws.send(JSON.stringify({ type: "prompt", sessionId: st.sessionId, text: ask("OK1") }));
        break;
      case "event":
        if (msg.kind === "turn_end" && msg.sessionId === st.sessionId) {
          // Wire-layer events may arrive duplicated: the first waiter to wake wins
          if (st.phase === 0) {
            st.phase = 1;
            console.log("断言1 ✓ 新会话第 1 轮 turn_end 到达");
            ws.send(JSON.stringify({ type: "prompt", sessionId: st.sessionId, text: ask("OK2") }));
          } else if (st.phase === 1) {
            st.phase = 2;
            st.gotEnd = true;
            console.log("断言2 ✓ 第 2 轮（同会话续发）turn_end 到达");
          }
        }
        break;
      case "error":
        fail(`阶段 A 收到 error: ${msg.message}`);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const iv = setInterval(() => {
      if (st.gotEnd) {
        clearInterval(iv);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(iv);
      reject(new Error("阶段 A 未完成"));
    }, 180_000);
  });
  clearTimeout(timer);
  ws.close();
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1000)); // Wait for the host to exit and flush to disk
  child = null;
}

// ---------- Phase B: restart the host, cold-load the historical session ----------
{
  const { child: c, wsUrl } = await startHost();
  child = c;
  const ws = await connect(wsUrl);
  const path = createdFiles[0];
  const st = {
    sessionId: "" as string,
    loaded: false,
    sawHistory: false,
    gotEnd: false,
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    switch (msg.type) {
      case "ready":
        ws.send(JSON.stringify({ type: "load_session", path }));
        break;
      case "session_created":
        if (!st.loaded) {
          st.loaded = true;
          st.sessionId = msg.sessionId;
          console.log(`历史会话加载: ${msg.sessionId.slice(0, 8)}`);
        }
        break;
      case "messages":
        if (st.loaded && !st.sawHistory) {
          st.sawHistory = true;
          const texts = (msg.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => m.text);
          const ok = texts.some((t: string) => t.includes("OK1")) && texts.some((t: string) => t.includes("OK2"));
          if (!ok) fail(`历史 transcript 缺前两轮 user 消息: ${JSON.stringify(texts)}`);
          console.log("断言3a ✓ 冷加载 transcript 含前两轮消息");
          ws.send(JSON.stringify({ type: "prompt", sessionId: st.sessionId, text: ask("OK3") }));
        }
        break;
      case "event":
        if (msg.kind === "turn_end" && msg.sessionId === st.sessionId && st.sawHistory) {
          st.gotEnd = true;
          console.log("断言3b ✓ 历史会话续发 turn_end 到达");
        }
        break;
      case "error":
        fail(`阶段 B 收到 error: ${msg.message}`);
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("阶段 B 超时（120s）")), 120_000);
    const iv = setInterval(() => {
      if (st.gotEnd) {
        clearInterval(iv);
        clearTimeout(timer);
        resolve();
      }
    }, 200);
  });
  ws.close();
  child.kill("SIGTERM");
  child = null;
}

restoreCfg();
await cleanup();
console.log("三轮发送冒烟通过 ✓（宿主层 create/续发/冷加载历史全通，bug 不在宿主协议层）");
process.exit(0);
