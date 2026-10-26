// Smoke: dual-channel (local desktop + remote control) session-frame sync.
// Regression matrix for the 2026-10-19 cross-channel fan-out fixes:
//   1. prompt user_message echo reaches the OTHER attached UI, not the sender
//   2. bash_exec stream frames (start/chunk/done) fan out to every attached UI
//   3. session_created carries the busy field (mid-run open spinner seed)
//   4. remote load_session on a live pooled entry attaches without evicting
//      the local channel (dual-subscription precondition for all of the above)
// Spawns `bun host/host.ts` under the omp-desktop-test profile (smoke-profile.ts).
// Any failed assertion exits non-zero. Usage: bun scripts/smoke-dual-channel.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { smokeEnv } from "./smoke-profile.ts";

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));

let checkCount = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  checkCount += 1;
  console.log(`  ✓ ${msg}`);
}
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let child: ChildProcess | null = null;
let hostOut = "";
let hostExit: Promise<number> | null = null;

function startHost(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  child = spawn("bun", ["host/host.ts"], { cwd: repoRoot, env: smokeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const exit = Promise.withResolvers<number>();
  hostExit = exit.promise;
  child.once("exit", (code) => exit.resolve(code ?? -1));
  const timer = setTimeout(() => reject(new Error("host 30s 未输出 READY")), 30_000);
  const onChunk = (chunk: Buffer) => {
    hostOut += chunk.toString();
    const m = hostOut.match(/READY ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
  };
  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);
  child.once("exit", (code) => reject(new Error(`host 在 READY 前退出 code=${code}`)));
  return promise;
}

async function stopHost(): Promise<void> {
  if (!child?.pid) return;
  child.kill("SIGTERM");
  const code = await Promise.race([hostExit, delay(10_000).then(() => null)]);
  if (code === null) {
    child.kill("SIGKILL");
    await hostExit;
  }
  child = null;
}

function freePort(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const addr = s.address() as AddressInfo;
    s.close(() => resolve(addr.port));
  });
  return promise;
}

interface WsHandle {
  rpc<T extends Record<string, unknown>>(type: string, payload?: Record<string, unknown>, replyType?: string): Promise<T>;
  sendRaw(type: string, payload?: Record<string, unknown>): void;
  strayFrames: Record<string, unknown>[];
  ready: Promise<Record<string, unknown>>;
  close(): void;
}

function connectWs(url: string): WsHandle {
  const ws = new WebSocket(url);
  const pending = new Map<string, (msg: Record<string, unknown>) => void>();
  const readyRes = Promise.withResolvers<Record<string, unknown>>();
  const stray: Record<string, unknown>[] = [];
  pending.set("__ready__", (msg) => readyRes.resolve(msg));
  const readyTimer = setTimeout(() => {
    if (pending.delete("__ready__")) readyRes.reject(new Error("ready 帧超时"));
  }, 15_000);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (msg.type === "ready" && pending.has("__ready__")) {
      pending.get("__ready__")!(msg);
      pending.delete("__ready__");
      clearTimeout(readyTimer);
    } else if (typeof msg.type === "string" && pending.has(msg.type)) {
      pending.get(msg.type)!(msg);
      pending.delete(msg.type);
    } else {
      stray.push(msg);
    }
  };
  ws.onerror = () => {
    clearTimeout(readyTimer);
    if (pending.delete("__ready__")) readyRes.reject(new Error("连接错误(未收到 ready)"));
  };
  return {
    ready: readyRes.promise,
    strayFrames: stray,
    rpc<T extends Record<string, unknown>>(type: string, payload: Record<string, unknown> = {}, replyType?: string): Promise<T> {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const t = setTimeout(() => {
        pending.delete(replyType ?? type);
        reject(new Error(`${type} 超时`));
      }, 15_000);
      pending.set(replyType ?? type, (msg) => {
        clearTimeout(t);
        resolve(msg as T);
      });
      ws.send(JSON.stringify({ reqId: Date.now() + Math.random(), type, ...payload }));
      return promise;
    },
    sendRaw(type: string, payload: Record<string, unknown> = {}): void {
      ws.send(JSON.stringify({ reqId: Date.now() + Math.random(), type, ...payload }));
    },
    close: () => ws.close(),
  };
}

async function waitForStray(
  stray: Record<string, unknown>[],
  pred: (m: Record<string, unknown>) => boolean,
  ms = 4000,
): Promise<Record<string, unknown> | undefined> {
  const t0 = Date.now();
  for (;;) {
    const hit = stray.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) return undefined;
    await delay(50);
  }
}

async function main(): Promise<void> {
  const port = await startHost();
  const mainWs = connectWs(`ws://127.0.0.1:${port}`);
  await mainWs.ready;
  console.log("host 就绪, 本机通道已连接");

  // Enable the remote server and dial the second (remote-control) channel
  const remotePort = await freePort();
  await mainWs.rpc("set_remote_config", { enabled: true, port: remotePort }, "remote_config");
  const settings = await mainWs.rpc<{ settings: { remote?: { key?: string } } }>("get_settings", {}, "settings");
  const key = settings.settings.remote?.key ?? "";
  assert(/^[0-9a-f]{32}$/.test(key), "远程服务已开启且拿到 accessKey");
  const remoteWs = connectWs(`ws://127.0.0.1:${remotePort}/ws?t=${key}`);
  await remoteWs.ready;
  console.log("远程通道已连接");

  // Local channel creates a session
  const cwd = mkdtempSync(`${tmpdir()}/dual-ch-`);
  const created = await mainWs.rpc<{ sessionId: string; path: string }>("create_session", { cwd }, "session_created");
  assert(typeof created.sessionId === "string" && created.sessionId.length > 0, "本机通道 create_session 成功");

  // Remote channel loads the same live entry (dual subscription, the precondition)
  const loaded = await remoteWs.rpc<{ sessionId: string; busy: unknown }>("load_session", { path: created.path }, "session_created");
  assert(loaded.sessionId === created.sessionId, "远程通道 load_session 复用同一会话");
  assert(typeof loaded.busy === "boolean", "session_created 帧携带 busy 字段(中途打开进行中会话的转圈种子)");

  // --- Matrix 2: bash stream fans out to the remote channel ---
  mainWs.rpc("bash_exec", { sessionId: created.sessionId, command: "printf dual-ch-echo" }, "bash_start").catch(() => {});
  const remoteBashStart = await waitForStray(remoteWs.strayFrames, (m) => m.type === "bash_start" && m.sessionId === created.sessionId);
  assert(remoteBashStart !== undefined, "远程通道收到 bash_start(修复前仅回请求方)");
  const remoteBashDone = await waitForStray(remoteWs.strayFrames, (m) => m.type === "bash_done" && m.sessionId === created.sessionId);
  assert(remoteBashDone !== undefined, "远程通道收到 bash_done(bash 卡片双端同步)");

  // --- Matrix 1: prompt echo reaches the other side, not the sender ---
  mainWs.sendRaw("prompt", { sessionId: created.sessionId, text: "dual-channel-probe" });
  const echo = await waitForStray(remoteWs.strayFrames, (m) => m.type === "event" && m.kind === "user_message" && m.text === "dual-channel-probe");
  assert(echo !== undefined, "远程通道收到 user_message 回显(修复前另一端永远看不到对端发的消息)");
  await delay(400); // negative assertion window: the sender must not get its own echo
  const selfEcho = mainWs.strayFrames.find((m) => m.type === "event" && m.kind === "user_message" && m.text === "dual-channel-probe");
  assert(selfEcho === undefined, "发送方不收到自身回显(避免与乐观气泡重复)");

  // --- Matrix: terminal run end notifies channels that never attached ---
  // Fresh session no other channel loaded: pool_sessions busy broadcast proves the
  // run-lifecycle path is live, and session_finished (if the prompt run terminates)
  // must reach the remote channel even without a slot. Soft window: the no-model
  // test profile may fail the turn instantly; both frames ride the same fix.
  const fin = await waitForStray(remoteWs.strayFrames, (m) => m.type === "session_finished", 6000);
  if (fin !== undefined) {
    assert(fin.sessionId === created.sessionId && fin.path === created.path, "远程通道收到 session_finished 完成通知(未 attach 的通道也能亮未读点)");
  } else {
    console.log("  · session_finished 未在本窗口触发(测试环境无模型, turn 未进入 agent 循环) — 该路径由真机双端验证");
  }

  // --- Matrix: remote device history records the authenticated remote visit ---
  // recordRemoteDevice ran during the remote channel's open; the push settings frame
  // carries the visitor. The smoke WS sends no User-Agent, so name falls back to "Unknown".
  const devFrame = await waitForStray(mainWs.strayFrames, (m) => {
    if (m.type !== "settings" || typeof m.settings !== "object" || m.settings === null) return false;
    const r = (m.settings as Record<string, unknown>).remote as Record<string, unknown> | undefined;
    return Array.isArray(r?.devices) && (r.devices as Record<string, unknown>[]).some((d) => d.ip === "127.0.0.1");
  });
  assert(devFrame !== undefined, "远程连接后 settings 帧携带设备历史(本机通道收到含 ip 的 devices)");
  const devSettings = devFrame!.settings as { remote: { devices: { name: string; ip: string; lastAt: number }[] } };
  const rec = devSettings.remote.devices.find((d) => d.ip === "127.0.0.1")!;
  assert(typeof rec.name === "string" && rec.name.length > 0 && typeof rec.lastAt === "number", "设备记录含名称与最近访问时间");

  // --- Matrix: state writes reach the OTHER channel, not just the asker ---
  // Same class as BUG-100: a receipt only the requester sees leaves the other end's
  // composer badge / settings copy stale until reload. Both senders below are
  // process- or session-scoped writes the other channel renders.
  remoteWs.strayFrames.length = 0;
  mainWs.sendRaw("set_thinking", { sessionId: created.sessionId, level: "low" });
  const thinkingEcho = await waitForStray(remoteWs.strayFrames, (m) => m.type === "session_thinking" && m.level === "low");
  assert(thinkingEcho !== undefined, "远程通道收到 session_thinking(推理档位双端同步,修复前只回请求方)");

  remoteWs.strayFrames.length = 0;
  mainWs.sendRaw("reload_settings", {}); // disk re-read only: no persistence, pushes models + settings
  const settingsEcho = await waitForStray(remoteWs.strayFrames, (m) => m.type === "settings");
  assert(settingsEcho !== undefined, "远程通道收到 settings 快照(主机设置不再冻结在连接时刻)");

  remoteWs.close();
  mainWs.close();
  await stopHost();
  console.log(`\n双通道同步冒烟通过: ${checkCount} 项断言`);
}

try {
  await main();
} catch (err) {
  console.error(`\n冒烟失败: ${(err as Error).message}`);
  if (child?.pid) {
    child.kill("SIGKILL");
    await hostExit;
  }
  process.exit(1);
}
