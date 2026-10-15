// Skill-command smoke test: the new-session page's command list must run its
// own cwd-scoped discovery (project-level .agents/skills included) instead of
// borrowing a pooled session's snapshot, and asset_skill_toggle must refresh
// live sessions' skill lists (the base listener skips disabledExtensions).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-skill-commands.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const profile = process.env.OMP_PROFILE || "omp-desktop-test";
const cfgPath = path.join(homedir(), ".omp/profiles", profile, "agent/omp-desktop.json");
const cfgExisted = existsSync(cfgPath);
const cfgBackup = cfgExisted ? readFileSync(cfgPath, "utf8") : null;

// Project under test with a project-level skill, plus an unrelated cwd
const proj = mkdtempSync(path.join(tmpdir(), "smoke-skill-cmd-"));
const other = mkdtempSync(path.join(tmpdir(), "smoke-skill-other-"));
const skillDir = path.join(proj, ".agents", "skills", "smoke-skill-x");
mkdirSync(skillDir, { recursive: true });
writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: smoke-skill-x\ndescription: smoke project skill\n---\nbody");

let child: ChildProcess | null = null;
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    child.kill("SIGTERM");
    // Windows: SIGTERM does not tear down the bun process tree; force-kill by
    // pid or the host lingers as an orphan (machine-resource red line).
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    }
    child = null;
  }
  try {
    if (cfgExisted && cfgBackup) writeFileSync(cfgPath, cfgBackup);
    else if (existsSync(cfgPath)) unlinkSync(cfgPath);
  } catch {}
  rmSync(proj, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}

function fail(msg: string): never {
  console.error("✗ " + msg);
  restore();
  process.exit(1);
}

process.on("SIGINT", () => { restore(); process.exit(1); });
process.on("SIGTERM", () => { restore(); process.exit(1); });

child = spawn("bun", ["host/host.ts"], {
  cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, OMP_PROFILE: profile },
  stdio: ["ignore", "pipe", "inherit"],
});

const ready = Promise.withResolvers<string>();
const readyTimer = setTimeout(() => ready.reject(new Error("宿主 30s 未就绪")), 30_000);
child.stdout!.setEncoding("utf8");
child.stdout!.on("data", function onLine(chunk) {
  const m = chunk.match(/READY (ws:\/\/\S+)/);
  if (m) {
    clearTimeout(readyTimer);
    child!.stdout!.off("data", onLine);
    ready.resolve(m[1]);
  }
});
const wsUrl = await ready.promise.catch((e: unknown) => fail(String(e)));
console.log("宿主已就绪:", wsUrl);

const ws = new WebSocket(wsUrl);
const failTimer = setTimeout(() => fail("超时未完成技能命令断言"), 120_000);

// Frame log with one pending waiter slot: each assertion records the current
// frame count and waits for the next frame of that type.
const frames: Record<string, any[]> = {};
let waiter: { type: string; resolve: () => void } | null = null;
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  (frames[msg.type] ??= []).push(msg);
  if (waiter && waiter.type === msg.type) {
    waiter.resolve();
    waiter = null;
  }
});

const opened = Promise.withResolvers<void>();
ws.addEventListener("open", () => opened.resolve());
if (ws.readyState === WebSocket.OPEN) opened.resolve();
await opened.promise;

async function nextFrame(type: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  waiter = { type, resolve };
  const timer = setTimeout(resolve, 15_000); // safety release; assertion decides pass/fail
  await promise;
  clearTimeout(timer);
}

// Wait until at least one more frame of `type` lands beyond `base` count.
async function frameBeyond(type: string, base: number): Promise<void> {
  while ((frames[type]?.length ?? 0) <= base) await nextFrame(type);
}

function latestCommands(): Array<{ name: string; source: string }> {
  const list = frames.commands ?? [];
  return list.length ? list[list.length - 1].commands : [];
}

const hasSkill = (cmds: Array<{ name: string }>) => cmds.some((c) => c.name === "skill:smoke-skill-x");

// 1. Session in an unrelated cwd: the pool now holds a cross-cwd entry
ws.send(JSON.stringify({ type: "create_session", cwd: other }));
await frameBeyond("session_created", 0);
const sid2Created = await (async () => {
  const list = frames.session_created!;
  return list[list.length - 1].sessionId as string;
})();
console.log("已建无关目录会话:", sid2Created);

// 2. New-session page for the skill project: must include the project skill
// (old code borrowed the unrelated session's snapshot and dropped it)
ws.send(JSON.stringify({ type: "list_commands", cwd: proj }));
await frameBeyond("commands", 0);
if (!hasSkill(latestCommands())) fail("新建会话页命令列表缺少项目级技能 skill:smoke-skill-x（借用陈旧快照回归）");
console.log("✓ 新建页包含项目级技能");

// 3. Session in the skill project sees its project skill
ws.send(JSON.stringify({ type: "create_session", cwd: proj }));
await frameBeyond("session_created", frames.session_created!.length);
const sidProj = frames.session_created![frames.session_created!.length - 1].sessionId as string;
ws.send(JSON.stringify({ type: "list_commands", sessionId: sidProj }));
await frameBeyond("commands", frames.commands!.length);
if (!hasSkill(latestCommands())) fail("会话命令列表缺少项目级技能 skill:smoke-skill-x");
console.log("✓ 会话命令列表包含项目级技能");

// 4. Disable via toggle: the live session's list must refresh too
ws.send(JSON.stringify({ type: "asset_skill_toggle", name: "smoke-skill-x", enabled: false }));
await frameBeyond("agent_assets", 0);
ws.send(JSON.stringify({ type: "list_commands", sessionId: sidProj }));
await frameBeyond("commands", frames.commands!.length);
if (hasSkill(latestCommands())) fail("禁用后已建会话命令列表仍出现 skill:smoke-skill-x（会话未刷新）");
console.log("✓ 禁用后已建会话不再出现");

// 5. Re-enable: the new-session page must offer it again
ws.send(JSON.stringify({ type: "asset_skill_toggle", name: "smoke-skill-x", enabled: true }));
await frameBeyond("agent_assets", frames.agent_assets!.length);
ws.send(JSON.stringify({ type: "list_commands", cwd: proj }));
await frameBeyond("commands", frames.commands!.length);
if (!hasSkill(latestCommands())) fail("启用后新建页未恢复 skill:smoke-skill-x");
console.log("✓ 启用后新建页恢复");

clearTimeout(failTimer);
console.log("✓ 技能命令冒烟全部通过");
restore();
process.exit(0);
