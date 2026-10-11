// Kimi auto-thinking switch smoke test: verifies the gate pure functions
// (host/kimi-thinking.ts) against the test profile's omp-desktop.json, then
// drives the real host over WebSocket to check the providers-page RPC
// (set_kimi_auto_thinking) and its settings-frame projection.
// Covers: default off, kimi+auto pinned to high, other providers untouched,
// merge-write preserving other keys/sections, RPC round-trip + disk persistence.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-kimi-auto-thinking.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { H } from "../host/state.ts";
import { gateKimiAutoThinking, readKimiAutoThinking, writeKimiAutoThinking } from "../host/kimi-thinking.ts";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const agentDir = path.join(homedir(), ".omp/profiles", profile, "agent");
const cfgPath = path.join(agentDir, "omp-desktop.json");

const backup = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    if (backup) writeFileSync(cfgPath, backup);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restore();
  process.exit(1);
}

process.on("SIGINT", () => {
  restore();
  process.exit(1);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(1);
});

// ---------- Part 1: pure-function gate against the test profile file ----------
// Seed a marker key first so the merge-write assertions have something to preserve
try {
  const seeded = { smokeMarker: { keep: 42 } };
  writeFileSync(cfgPath, JSON.stringify(seeded, null, 2));
} catch (e) {
  fail(`写入测试配置失败: ${String(e)}`);
}

H.desktopProjectsPath = cfgPath; // point the shared reader/writer at the test profile

function assert(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

// Default (no kimi section): off
assert(readKimiAutoThinking() === false, "默认应为关闭");
assert(gateKimiAutoThinking("kimi-code", "auto") === "high", "Kimi + auto + 关 应钉到 high");
assert(gateKimiAutoThinking("kimi-code", "high") === "high", "Kimi 具体档位应原样通过");
assert(gateKimiAutoThinking("deepseek", "auto") === "auto", "非 Kimi 的 auto 应原样通过");
assert(gateKimiAutoThinking(undefined, "auto") === "auto", "未知 provider 的 auto 应原样通过");

// Enable: kimi auto passes through, file + marker survive the merge-write
writeKimiAutoThinking(true);
assert(readKimiAutoThinking() === true, "写入后应读取到 true");
assert(gateKimiAutoThinking("kimi-code", "auto") === "auto", "开启后 Kimi + auto 应放行");
const afterOn = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
assert((afterOn.kimi as Record<string, unknown>)?.autoThinking === true, "磁盘应记录 kimi.autoThinking=true");
assert((afterOn.smokeMarker as Record<string, unknown>)?.keep === 42, "合并写入应保留其他顶层键");

// Disable again: back to pinned, file + marker still intact
writeKimiAutoThinking(false);
assert(gateKimiAutoThinking("kimi-code", "auto") === "high", "关闭后应重新钉到 high");
const afterOff = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
assert((afterOff.kimi as Record<string, unknown>)?.autoThinking === false, "磁盘应记录 kimi.autoThinking=false");
assert((afterOff.smokeMarker as Record<string, unknown>)?.keep === 42, "合并写入应保留其他顶层键（关闭后）");
console.log("✓ 纯函数 gate：默认关 / kimi+auto→high / 他厂 auto 放行 / 开关切换 / 合并写保留");

// ---------- Part 2: real host over WebSocket ----------
writeFileSync(cfgPath, JSON.stringify({ smokeMarker: { keep: 42 } }, null, 2)); // clean slate for the RPC leg
let child: ChildProcess | null = null;
child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, OMP_PROFILE: profile },
  stdio: ["ignore", "pipe", "inherit"],
});

const wsUrl = await new Promise<string>((resolve, reject) => {
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

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => fail("超时未完成 RPC 断言"), 60_000);
let stage = 0;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "get_settings" }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as { type: string; settings?: Record<string, unknown> };
  if (msg.type !== "settings") return;
  const s = msg.settings ?? {};

  if (stage === 0) {
    if (s.kimiAutoThinking !== false) fail(`初始 kimiAutoThinking 应为 false，实际 ${String(s.kimiAutoThinking)}`);
    stage = 1;
    console.log("步骤 1: set_kimi_auto_thinking -> true");
    ws.send(JSON.stringify({ type: "set_kimi_auto_thinking", enabled: true }));
  } else if (stage === 1) {
    if (s.kimiAutoThinking !== true) fail(`开启后帧应回 true，实际 ${String(s.kimiAutoThinking)}`);
    const disk = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    if ((disk.kimi as Record<string, unknown>)?.autoThinking !== true) fail("开启后应落盘 kimi.autoThinking=true");
    if ((disk.smokeMarker as Record<string, unknown>)?.keep !== 42) fail("RPC 写入应保留其他顶层键");
    stage = 2;
    console.log("步骤 2: set_kimi_auto_thinking -> false");
    ws.send(JSON.stringify({ type: "set_kimi_auto_thinking", enabled: false }));
  } else if (stage === 2) {
    if (s.kimiAutoThinking !== false) fail(`关闭后帧应回 false，实际 ${String(s.kimiAutoThinking)}`);
    const disk = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    if ((disk.kimi as Record<string, unknown>)?.autoThinking !== false) fail("关闭后应落盘 kimi.autoThinking=false");
    if ((disk.smokeMarker as Record<string, unknown>)?.keep !== 42) fail("RPC 写入应保留其他顶层键（关闭后）");
    clearTimeout(timer);
    console.log("✓ RPC 链路：默认 false → set true（帧+落盘+保留他键）→ set false（帧+落盘）");
    ws.close();
    child?.kill("SIGTERM");
    child = null;
    restore();
    console.log("✓ Kimi auto thinking 冒烟全部通过");
    process.exit(0);
  }
};

ws.onerror = () => fail("WebSocket 错误");
