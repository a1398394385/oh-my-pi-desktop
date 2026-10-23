// Probe: LAN remote-control acceptance matrix 1-7 (spec §5) against a real host.
// Spawns `bun host/host.ts` under the omp-desktop-test profile (smoke-profile.ts
// precedent), drives the remote server over HTTP/WebSocket, and asserts every
// scenario: 401 auth, ready handshake, write denylist, single-connection kick,
// static serving, set_remote_config enable/disable/rebind/EADDRINUSE, and
// remote_regenerate_key persistence across a host restart.
// Any failed assertion exits non-zero. Usage: bun scripts/probe-remote.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket, type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { smokeEnv, profileAgentPath } from "./smoke-profile.ts";

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));

// ---------- tiny assert ----------
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

// ---------- host process (spawn/kill, READY + [remote] listening parsed from output) ----------
let child: ChildProcess | null = null;
let hostOut = "";
let hostExit: Promise<number> | null = null;

function startHost(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  child = spawn("bun", ["host/host.ts"], { cwd: repoRoot, env: smokeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  hostExit = new Promise((codeResolve) => child!.once("exit", (code) => codeResolve(code ?? -1)));
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
  child.stderr!.on("data", onChunk); // host diagnostics (safeStderr) land on stderr
  child.once("exit", (code) => reject(new Error(`host 在 READY 前退出 code=${code}`)));
  return promise;
}

async function waitForRemoteListening(timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  const mark = hostOut.length;
  for (;;) {
    const m = hostOut.slice(mark).match(/\[remote\] listening port=(\d+)/);
    if (m) return Number(m[1]);
    if (Date.now() - start > timeoutMs) throw new Error("等待 [remote] listening 超时");
    await delay(100);
  }
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

// ---------- TCP / raw-HTTP helpers ----------
function tcpOpen(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const s = new Socket();
  s.setTimeout(800, () => {
    s.destroy();
    resolve(false);
  });
  s.once("connect", () => {
    s.destroy();
    resolve(true);
  });
  s.once("error", () => resolve(false));
  s.connect(port, "127.0.0.1");
  return promise;
}

function rawHttp(port: number, requestLine: string, extraHeaders = ""): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const sock = new Socket();
  let raw = "";
  sock.setTimeout(5_000, () => {
    sock.destroy();
    reject(new Error(`raw http 超时: ${requestLine}`));
  });
  sock.connect(port, "127.0.0.1", () => {
    sock.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extraHeaders}\r\n`);
  });
  sock.on("data", (c) => (raw += c.toString("utf8")));
  sock.on("end", () => {
    const m = raw.match(/^HTTP\/1\.1 (\d{3})/m);
    resolve({ status: m ? Number(m[1]) : 0, body: raw });
  });
  sock.on("error", reject);
  return promise;
}

function freePort(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const addr: string | AddressInfo | null = s.address();
    if (typeof addr === "object" && addr !== null) {
      const port = addr.port;
      s.close(() => resolve(port));
    } else {
      s.close(() => resolve(0)); // pragma: no cover — loopback listen always yields an AddressInfo
    }
  });
  return promise;
}

// ---------- WebSocket client ----------
interface WsHandle {
  rpc<T extends Record<string, unknown>>(type: string, payload?: Record<string, unknown>, replyType?: string): Promise<T>;
  strayFrames: Record<string, unknown>[];
  ready: Promise<Record<string, unknown>>;
  closeCode: Promise<number>;
  kickedSeen: boolean;
  close(): void;
}

function connectWs(url: string): WsHandle {
  const ws = new WebSocket(url);
  const pending = new Map<string, (msg: Record<string, unknown>) => void>();
  const readyRes = Promise.withResolvers<Record<string, unknown>>();
  const closeRes = Promise.withResolvers<number>();
  const state = { kickedSeen: false };
  // Frames that match no pending waiter (host pushes like the settings refresh): kept
  // so probes can assert broadcast behavior, not just request/reply pairs
  const stray: Record<string, unknown>[] = [];
  pending.set("__ready__", (msg) => readyRes.resolve(msg));
  const readyTimer = setTimeout(() => {
    if (pending.delete("__ready__")) readyRes.reject(new Error("ready 帧超时"));
  }, 15_000);
  ws.onmessage = (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as Record<string, unknown>; // boundary: JSON frame from our own host; fields narrowed below
    if (msg.type === "kicked") state.kickedSeen = true;
    if (msg.type === "ready" && pending.has("__ready__")) {
      pending.get("__ready__")!(msg);
      pending.delete("__ready__");
      clearTimeout(readyTimer);
    } else if (msg.type === "error" && pending.size > 0) {
      // Host error reply: resolve the oldest waiter (probe sends serially; denylist tests expect this frame)
      const first = pending.entries().next().value as [string, (msg: Record<string, unknown>) => void] | undefined;
      if (first) {
        pending.delete(first[0]);
        first[1](msg);
      }
    } else if (typeof msg.type === "string" && pending.has(msg.type)) {
      pending.get(msg.type)!(msg);
      pending.delete(msg.type);
    } else {
      stray.push(msg);
    }
  };
  ws.onerror = () => {
    clearTimeout(readyTimer);
    if (pending.has("__ready__")) {
      pending.delete("__ready__");
      readyRes.reject(new Error("连接错误(未收到 ready)"));
    }
  };
  ws.onclose = (ev) => closeRes.resolve(ev.code);
  return {
    get kickedSeen() {
      return state.kickedSeen;
    },
    ready: readyRes.promise,
    closeCode: closeRes.promise,
    rpc<T extends Record<string, unknown>>(type: string, payload: Record<string, unknown> = {}, replyType?: string): Promise<T> {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const t = setTimeout(() => {
        pending.delete(replyType ?? type);
        reject(new Error(`${type} 超时`));
      }, 15_000);
      pending.set(replyType ?? type, (msg) => {
        clearTimeout(t);
        resolve(msg as T); // reply frame shape asserted by each caller
      });
      ws.send(JSON.stringify({ reqId: Date.now() + Math.random(), type, ...payload }));
      return promise;
    },
    close: () => ws.close(),
    strayFrames: stray,
  };
}

/** Poll a handle's stray-frame buffer for a broadcast frame matching pred (host pushes arrive async). */
async function waitForStray(
  stray: Record<string, unknown>[],
  pred: (m: Record<string, unknown>) => boolean,
  ms = 3000,
): Promise<Record<string, unknown> | undefined> {
  const t0 = Date.now();
  for (;;) {
    const hit = stray.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) return undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

/** A WS connection that never becomes ready: rejected-upgrade cases (bad/missing key). */
async function expectWsRejected(url: string, label: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const ws = new WebSocket(url);
  let gotReady = false;
  const t = setTimeout(() => {
    ws.close();
    reject(new Error(`${label}: 连接既未 ready 也未关闭`));
  }, 5_000);
  ws.onmessage = (e) => {
    try {
      const parsed: unknown = JSON.parse(String(e.data));
      if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "ready") gotReady = true;
    } catch {
      // ignore non-JSON
    }
  };
  ws.onerror = () => undefined; // rejection surfaces via onclose
  ws.onclose = () => {
    clearTimeout(t);
    if (gotReady) reject(new Error(`${label}: 错误 key 却收到 ready 帧`));
    else resolve();
  };
  return promise;
}

async function closeWithCode(ws: WsHandle, label: string): Promise<number> {
  const code = await Promise.race([ws.closeCode, delay(8_000).then(() => -1)]);
  if (code === -1) throw new Error(`${label}: 等待关闭超时`);
  return code;
}

function frameField<T>(msg: Record<string, unknown>, key: string): T | undefined {
  return key in msg ? (msg[key] as T) : undefined; // field presence narrowed by the `in` check
}

// ---------- main ----------
const fail = (msg: string): never => {
  console.error("✗ " + msg);
  void stopHost().finally(() => process.exit(1));
  throw new Error(msg); // keeps TS flow honest; stopHost exits first in practice
};

const guard = setTimeout(() => fail("180s 总超时"), 180_000);

try {
  const [p1, p2, p3] = [await freePort(), await freePort(), await freePort()];
  console.log(`端口: P1=${p1} P2=${p2} P3(占用测试)=${p3}`);

  // ---- spawn host, drive everything through the primary (main) WS first ----
  const wsPort = await startHost();
  console.log(`host READY ws://127.0.0.1:${wsPort}`);
  const main = connectWs(`ws://127.0.0.1:${wsPort}`);
  await main.ready;
  assert(true, "主服务 ready 帧收到");

  // Matrix 6 (enable): enable on P1 -> listening, key auto-generated
  let reply = await main.rpc<{ enabled: boolean; port: number }>("set_remote_config", { enabled: true, port: p1 }, "remote_config");
  assert(reply.enabled === true && reply.port === p1, "矩阵6: 开启远程服务 remote_config.enabled/port 正确");
  // Regression: enable must push a typed settings frame carrying remote.url — the settings
  // page's copy-link button reads that URL; an untyped payload frame is silently dropped by
  // the UI dispatcher (bug found 2026-10-16: settingsFrame() sent without its "settings" wrapper)
  const pushed = await waitForStray(
    main.strayFrames,
    (m) => m.type === "settings" && !!(m.settings as { remote?: { url?: string } } | undefined)?.remote?.url,
  );
  assert(pushed !== undefined, "矩阵6: 开启成功后下推 settings 帧带 remote.url(复制链接数据源)");
  assert(await tcpOpen(p1), "矩阵6: P1 端口可连接");
  const settings1 = await main.rpc<{ settings: { remote?: { key?: string } } }>("get_settings", {}, "settings");
  const key0 = settings1.settings.remote?.key ?? "";
  assert(/^[0-9a-f]{32}$/.test(key0), "开启时自动生成 128-bit hex accessKey");

  // Narrow-client display preference (remote.mobileStatsBar): a request that carries only this
  // field must persist and push a settings frame WITHOUT touching the server — otherwise the
  // write is lost whenever the port is held by another host (the dev profile while the default
  // profile owns 16800), since startRemoteServer would fail and skip the write
  const prefReply = await main.rpc<{ enabled: boolean; port: number }>("set_remote_config", { mobileStatsBar: true }, "remote_config");
  assert(prefReply.enabled === true && prefReply.port === p1, "状态栏开关: 仅偏好变更不动服务(仍 enabled 且监听 P1)");
  const settingsPref = await main.rpc<{ settings: { remote?: { mobileStatsBar?: boolean } } }>("get_settings", {}, "settings");
  assert(settingsPref.settings.remote?.mobileStatsBar === true, "状态栏开关: settings 帧带 remote.mobileStatsBar");
  const persistedPref = JSON.parse(readFileSync(profileAgentPath("omp-desktop.json"), "utf8")) as { remote?: { mobileStatsBar?: boolean } };
  assert(persistedPref.remote?.mobileStatsBar === true, "状态栏开关: 已落盘 omp-desktop.json");
  assert(await tcpOpen(p1), "状态栏开关: P1 端口未被重启打断");

  // Matrix 7 (regenerate): new key in reply, differs from previous
  const key1 = (await main.rpc<{ key: string }>("remote_regenerate_key", {}, "remote_key")).key;
  assert(/^[0-9a-f]{32}$/.test(key1) && key1 !== key0, "矩阵7: remote_regenerate_key 应答新 32-hex key");

  // Matrix 6 (disable): stop -> P1 refused
  reply = await main.rpc<{ enabled: boolean }>("set_remote_config", { enabled: false }, "remote_config");
  assert(reply.enabled === false, "矩阵6: 关闭远程服务 remote_config.enabled=false");
  assert(!(await tcpOpen(p1)), "矩阵6: 关闭后 P1 连接被拒");

  // Matrix 6 (rebind): enable on P2 -> P1 released, P2 listening
  reply = await main.rpc<{ enabled: boolean; port: number }>("set_remote_config", { enabled: true, port: p2 }, "remote_config");
  assert(reply.enabled === true && reply.port === p2, "矩阵6: 换绑 P2 生效");
  assert(!(await tcpOpen(p1)) && (await tcpOpen(p2)), "矩阵6: 旧端口 P1 释放、新端口 P2 监听");

  // Matrix 6 (EADDRINUSE): occupied P3 -> error non-empty, previous state untouched
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(p3, "0.0.0.0", r)); // wildcard: a specific-IP bind would not conflict with the remote server's 0.0.0.0 bind on macOS
  reply = await main.rpc<{ enabled: boolean; port: number; error?: string }>("set_remote_config", { port: p3 }, "remote_config");
  assert(typeof reply.error === "string" && reply.error.length > 0, "矩阵6: 占用端口回 remote_config.error 非空");
  assert(reply.enabled === true && reply.port === p2, "矩阵6: 失败后保持原状(enabled/P2)");
  assert(await tcpOpen(p2), "矩阵6: 失败后 P2 仍在服务");
  await new Promise<void>((r) => blocker.close(() => r()));

  // ---- remote-side checks on P2 with key1 ----
  // Matrix 1: missing / wrong key -> 401, no upgrade, no ready frame
  let res = await rawHttp(p2, "GET /ws HTTP/1.1", "Upgrade: websocket\r\n");
  assert(res.status === 401, "矩阵1: 无 ?t= 升级请求回 401");
  res = await rawHttp(p2, "GET /ws?t=wrongkey HTTP/1.1", "Upgrade: websocket\r\n");
  assert(res.status === 401, "矩阵1: 错误 key 升级请求回 401");
  await expectWsRejected(`ws://127.0.0.1:${p2}/ws`, "M1: no-key WS");
  await expectWsRejected(`ws://127.0.0.1:${p2}/ws?t=wrongkey`, "M1: wrong-key WS");

  // Matrix 2: correct key -> ready frame + list_sessions answers
  const r1 = connectWs(`ws://127.0.0.1:${p2}/ws?t=${key1}`);
  const r1Ready = await r1.ready;
  assert(r1Ready.type === "ready" && frameField(r1Ready, "settings") !== undefined, "矩阵2: 正确 key 收到 ready 帧(含 settings)");
  const sessions = await r1.rpc<{ type: string }>("list_sessions", {}, "session_list");
  assert(sessions.type === "session_list", "矩阵2: list_sessions 正常应答");

  // Matrix 3: denylist -> error frame, value unchanged
  const localeBefore = (await r1.rpc<{ settings: { uiConfig?: { locale?: string } } }>("get_settings", {}, "settings")).settings.uiConfig?.locale;
  const denied = await r1.rpc<{ type: string; message?: string }>("set_locale", { lang: "en" });
  assert(denied.type === "error" && denied.message === "remote read-only", "矩阵3: set_locale 被 denylist 拒绝(remote read-only)");
  for (const m of ["set_approval_mode", "delete_session", "switch_profile"] as const) {
    const d = await r1.rpc<{ type: string; message?: string }>(m, m === "set_approval_mode" ? { mode: "auto" } : {});
    assert(d.type === "error" && d.message === "remote read-only", `矩阵3: ${m} 被 denylist 拒绝`);
  }
  const localeAfter = (await r1.rpc<{ settings: { uiConfig?: { locale?: string } } }>("get_settings", {}, "settings")).settings.uiConfig?.locale;
  assert(localeBefore === localeAfter, "矩阵3: get_settings 复查值未变");
  // reload_settings must stay allowed (BUG-078: it has no persistence side
  // effect — reloadFromDisk flushes pending writes then re-reads — and
  // openSessionByPath sends it on every session open; denying it made every
  // remote session click toast "remote read-only"). Placed after the locale
  // recheck: its settings frame re-reads the persisted locale and would
  // otherwise pollute that assertion.
  const reloaded = await r1.rpc<{ type: string }>("reload_settings", {}, "models");
  assert(reloaded.type === "models", "矩阵3: reload_settings 放行(回 models 帧非 error)");

  // Matrix 4 (channel-scoped takeover, spec §3.4): the remote join must NOT evict
  // the local desktop — takeover is per-channel (remote vs remote only). The
  // session's event stream then fans out to BOTH ends (dual subscription).
  assert(!main.kickedSeen, "矩阵4: 远程接入后本地未收到 kicked 帧");
  const mainAlive = await main.rpc<{ type: string }>("list_sessions", {}, "session_list");
  assert(mainAlive.type === "session_list", "矩阵4: 远程接入后本地 RPC 仍可用(本体未被顶)");
  // 4b dual event stream: create a session on the local side, open the same
  // session from the remote side, then rename it locally — the base's
  // onSessionNameChanged listener fans the title frame out to every attached UI
  const probeCwd = `${tmpdir()}/omp-remote-m4-${Date.now()}`;
  const created = await main.rpc<{ type: string; sessionId: string; path: string }>("create_session", { cwd: probeCwd }, "session_created");
  assert(created.type === "session_created" && !!created.path, "矩阵4: 本地创建会话成功");
  await r1.rpc<{ type: string }>("load_session", { path: created.path }, "session_created");
  const renamed = await main.rpc<{ type: string; ok?: boolean }>("rename_session", { sessionId: created.sessionId, title: "m4-dual-stream" }, "session_renamed");
  assert(renamed.type === "session_renamed" && renamed.ok === true, "矩阵4: 本地重命名会话成功");
  const [localTitle, remoteTitle] = await Promise.all([
    waitForStray(
      main.strayFrames,
      (m) => m.type === "session_title_changed" && m.sessionId === created.sessionId && m.title === "m4-dual-stream",
    ),
    waitForStray(
      r1.strayFrames,
      (m) => m.type === "session_title_changed" && m.sessionId === created.sessionId && m.title === "m4-dual-stream",
    ),
  ]);
  assert(localTitle !== undefined, "矩阵4: 会话事件帧到达本地 UI(双流)");
  assert(remoteTitle !== undefined, "矩阵4: 会话事件帧到达远程 UI(双流)");

  // Matrix 5: static serving
  const indexRes = await fetch(`http://127.0.0.1:${p2}/`);
  const indexBody = await indexRes.text();
  assert(indexRes.status === 200 && /<title|assets\//.test(indexBody), "M5: GET / 200 serves index.html");
  const assetPath = indexBody.match(/\/assets\/[\w.-]+\.(?:js|css)/)?.[0];
  if (assetPath) {
    const assetRes = await fetch(`http://127.0.0.1:${p2}${assetPath}`);
    assert(assetRes.status === 200, `矩阵5: 存在资产 ${assetPath} 200`);
  }
  // Encoded traversal is the shape that survives to the server (literal "/../" is normalized to "/host/main.ts"
  // by the client/URL layer per RFC 3986 §6.2.2, which then 404s inside dist) — this exercises the 400 branch.
  const traversal = await rawHttp(p2, "GET /%2e%2e%2fhost%2fmain.ts HTTP/1.1");
  assert(traversal.status === 400, `矩阵5: 路径穿越回 400(实际 ${traversal.status})`);
  const literalDots = await rawHttp(p2, "GET /../host/main.ts HTTP/1.1");
  assert(literalDots.status === 400 || literalDots.status === 404, `矩阵5: 字面 ../ 不泄露文件(实际 ${literalDots.status})`);
  const missing = await fetch(`http://127.0.0.1:${p2}/no-such-file-omp-remote`);
  assert(missing.status === 404, "矩阵5: 不存在路径 404");
  const postRes = await fetch(`http://127.0.0.1:${p2}/`, { method: "POST" });
  assert(postRes.status === 405, "矩阵5: 非 GET 方法 405");

  // Matrix 4: second connection kicks the first (kicked frame and/or close 4001); retake kicks back
  const r2 = connectWs(`ws://127.0.0.1:${p2}/ws?t=${key1}`);
  await r2.ready;
  const r1Code = await closeWithCode(r1, "矩阵4: 旧连接关闭");
  assert(r1.kickedSeen || r1Code === 4001, "矩阵4: 旧连接收到 kicked 帧或 close 4001");
  assert(r1Code === 4001, `矩阵4: 旧连接 close code=4001(实际 ${r1Code})`);
  const r3 = connectWs(`ws://127.0.0.1:${p2}/ws?t=${key1}`);
  await r3.ready; // retake (re-claim)
  const r2Code = await closeWithCode(r2, "矩阵4: 新端被顶关闭");
  assert(r2Code === 4001, `矩阵4: 重新接管后新端被顶 close code=4001(实际 ${r2Code})`);
  r3.close();

  // Matrix 7: regenerate -> old key dead immediately, persisted to omp-desktop.json
  const main2 = connectWs(`ws://127.0.0.1:${wsPort}`);
  await main2.ready;
  const key2 = (await main2.rpc<{ key: string }>("remote_regenerate_key", {}, "remote_key")).key;
  assert(/^[0-9a-f]{32}$/.test(key2) && key2 !== key1, "矩阵7: 再次应答新 key");
  res = await rawHttp(p2, `GET /ws?t=${key1} HTTP/1.1`, "Upgrade: websocket\r\n");
  assert(res.status === 401, "矩阵7: 旧 key 升级被拒(401)");
  await expectWsRejected(`ws://127.0.0.1:${p2}/ws?t=${key1}`, "M7: old-key WS rejected");
  const persistedRaw: unknown = JSON.parse(readFileSync(profileAgentPath("omp-desktop.json"), "utf8"));
  const persisted = persistedRaw as { remote?: { enabled?: boolean; port?: number; accessKey?: string } }; // profile-owned json; asserted field-by-field below
  assert(persisted.remote?.accessKey === key2, "矩阵7: 新 key 已持久化到 omp-desktop.json");

  // Matrix 7 (restart): host restart -> autostart on persisted port, new key still valid
  await stopHost();
  hostOut = "";
  const wsPort2 = await startHost();
  const listeningPort = await waitForRemoteListening();
  assert(listeningPort === p2, `矩阵7: 重启后自启于持久化端口 P2(实际 ${listeningPort})`);
  const r4 = connectWs(`ws://127.0.0.1:${p2}/ws?t=${key2}`);
  await r4.ready;
  assert(true, "矩阵7: 重启后新 key 仍有效(ready 帧)");
  r4.close();

  // ---- cleanup: leave the test profile with the remote server disabled ----
  const main3 = connectWs(`ws://127.0.0.1:${wsPort2}`);
  await main3.ready;
  const off = await main3.rpc<{ enabled: boolean }>("set_remote_config", { enabled: false }, "remote_config");
  assert(off.enabled === false, "清理: 远程服务已关闭");
  main3.close();
  await stopHost();
  clearTimeout(guard);
  console.log(`\n全部通过:${checkCount} 项断言(矩阵 1-7)`);
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
