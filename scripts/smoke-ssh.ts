// SSH remote workspace smoke test: ssh.json host CRUD over RPC, connectivity
// probes (failure path against a closed port; success path against a local
// lab sshd), remote workspace stub creation + marker, and the session/project
// flow on the stub (create_session → session_list with remote:true).
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-ssh.ts [host ws url]
// Profile isolation: the runner MUST pass OMP_PROFILE=omp-desktop-test; ssh.json
// and omp-desktop.json under that profile's agent dir are backed up and restored
// on every exit path, and the lab sshd (Git-for-Windows sshd.exe, MSYS paths)
// plus all created dirs are torn down.
// Zero model calls (create_session is exercised without prompting).
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (process.env.OMP_PROFILE !== "omp-desktop-test") {
  console.error("✗ 必须以 OMP_PROFILE=omp-desktop-test 运行（测试 Profile 隔离红线）");
  process.exit(1);
}

// Parsed WS frames are external input; narrow reads through these guards.
type Frame = { type: string };
const frames: Frame[] = [];

function frameField(frame: Frame, key: string): unknown {
  return (frame as Record<string, unknown>)[key];
}

function hostRows(frame: Frame): Array<Record<string, unknown>> {
  const hosts = frameField(frame, "hosts");
  return Array.isArray(hosts) ? (hosts as Array<Record<string, unknown>>) : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// ---------- lab sshd (optional E2E leg) ----------
const LAB_ROOT = join(tmpdir(), "omp-ssh-lab");
const SSHD_PORT = 2223;
const GIT_SSHD = "C:\\Program Files\\Git\\usr\\bin\\sshd.exe";
const GIT_KEYGEN = "C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe";
const hasLabSshd = existsSync(GIT_SSHD) && existsSync(GIT_KEYGEN);
let sshdProc: ChildProcess | null = null;
let labOk = false;

function runChecked(cmd: string, cmdArgs: string[]): boolean {
  return Bun.spawnSync([cmd, ...cmdArgs], { stdout: "ignore", stderr: "pipe" }).exitCode === 0;
}

function portListening(): boolean {
  const out = execSync("netstat -ano", { encoding: "utf8" });
  return new RegExp(`127\\.0\\.0\\.1:${SSHD_PORT}\\s.*LISTENING`).test(out);
}

function startLabSshd(): boolean {
  try {
    mkdirSync(LAB_ROOT, { recursive: true });
    // Keys persist across runs: a regenerated host key would trip the client's
    // known_hosts "host key changed" refusal and make the E2E leg flaky
    // Drop any stale lab entry from the default known_hosts (a previous lab's
    // key would be rejected as "host key changed"); accept-new re-adds it
    const knownHosts = join(homedir(), ".ssh", "known_hosts");
    if (existsSync(knownHosts)) {
      const kept = readFileSync(knownHosts, "utf8").split("\n").filter((l) => !l.includes(`[127.0.0.1]:${SSHD_PORT}`));
      writeFileSync(knownHosts, kept.join("\n"));
    }
    if (!existsSync(join(LAB_ROOT, "host_key")) && !runChecked(GIT_KEYGEN, ["-t", "ed25519", "-f", join(LAB_ROOT, "host_key"), "-N", ""])) return false;
    if (!existsSync(join(LAB_ROOT, "client_key"))) {
      if (!runChecked(GIT_KEYGEN, ["-t", "ed25519", "-f", join(LAB_ROOT, "client_key"), "-N", ""])) return false;
      cpSync(join(LAB_ROOT, "client_key.pub"), join(LAB_ROOT, "authorized_keys"));
    }
    writeFileSync(
      join(LAB_ROOT, "sshd_config"),
      [
        `Port ${SSHD_PORT}`,
        "ListenAddress 127.0.0.1",
        "HostKey /tmp/omp-ssh-lab/host_key",
        "PidFile /tmp/omp-ssh-lab/sshd.pid",
        "AuthorizedKeysFile /tmp/omp-ssh-lab/authorized_keys",
        "PasswordAuthentication no",
        "PubkeyAuthentication yes",
        "ChallengeResponseAuthentication no",
        "Subsystem sftp internal-sftp",
        "StrictModes no",
        "LogLevel FATAL",
      ].join("\n"),
    );
    // E2E remote dir: MSYS maps /tmp to the Windows temp dir
    rmSync(join(tmpdir(), "omp-ssh-e2e"), { recursive: true, force: true });
    mkdirSync(join(tmpdir(), "omp-ssh-e2e"), { recursive: true });
    sshdProc = spawn(GIT_SSHD, ["-D", "-e", "-f", join(LAB_ROOT, "sshd_config")], { stdio: "ignore" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !portListening()) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    return portListening();
  } catch (err) {
    console.error(`[lab-sshd] ${err}`);
    return false;
  }
}

function stopLabSshd() {
  if (sshdProc?.pid) {
    try { sshdProc.kill(); } catch {}
  }
  try { execSync("taskkill /F /IM sshd.exe", { stdio: "ignore" }); } catch {}
  // Keys stay in LAB_ROOT for the next run (host-key stability, see startLabSshd)
  try { unlinkSync(join(LAB_ROOT, "sshd_config")); } catch {}
  try { rmSync(join(tmpdir(), "omp-ssh-e2e"), { recursive: true, force: true }); } catch {}
}

// ---------- host + profile state backup ----------
// pi-utils profile layout: ~/.omp/profiles/<name>/agent (dirs.ts getProfileConfigRoot)
const agentDir = join(homedir(), ".omp", "profiles", process.env.OMP_PROFILE, "agent");
const sshJsonPath = join(agentDir, "ssh.json");
const desktopJsonPath = join(agentDir, "omp-desktop.json");
const backups: Array<[string, string | null]> = [];
for (const p of [sshJsonPath, desktopJsonPath]) {
  backups.push([p, existsSync(p) ? readFileSync(p, "utf8") : null]);
}
const stubDirs: string[] = [];

let child: ChildProcess | null = null;
let wsUrl = args[0];
let restored = false;

function restoreState() {
  if (restored) return;
  restored = true;
  if (child?.pid) {
    try { child.kill("SIGTERM"); } catch {}
    try { execSync("sleep 0.8"); } catch {}
  }
  for (const [p, content] of backups) {
    try {
      if (content === null) { if (existsSync(p)) unlinkSync(p); }
      else writeFileSync(p, content);
    } catch {}
  }
  for (const d of stubDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  stopLabSshd();
}
function fail(msg: string): never {
  console.error("✗ " + msg);
  restoreState();
  process.exit(1);
}

if (!wsUrl) {
  child = spawn("bun", ["host/host.ts"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = Promise.withResolvers<string>();
  const timer = setTimeout(() => ready.reject(new Error("宿主 30s 未就绪")), 30_000);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", function onLine(chunk: string) {
    const m = chunk.match(/READY (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      child!.stdout!.off("data", onLine);
      ready.resolve(m[1]);
    }
  });
  wsUrl = await ready.promise.catch((e) => fail(String(e)));
  console.log("宿主已就绪:", wsUrl);
}

const ws = new WebSocket(wsUrl);
const failTimeout = setTimeout(() => fail("90s 内未完成全部断言"), 90_000);

const waitType = (t: string, after = 0, ms = 20_000): Promise<Frame> => {
  const waiter = Promise.withResolvers<Frame>();
  const timer = setTimeout(() => waiter.reject(new Error(`等待 ${t} 帧超时`)), ms);
  const poll = () => {
    const hit = frames.findIndex((f, i) => i >= after && f.type === t);
    if (hit >= 0) {
      clearTimeout(timer);
      waiter.resolve(frames[hit]);
      return;
    }
    setTimeout(poll, 50);
  };
  poll();
  return waiter.promise;
};

const assert = (cond: boolean, msg: string) => {
  if (!cond) fail(msg);
  console.log("✓ " + msg);
};

ws.onmessage = (ev) => {
  const parsed: unknown = JSON.parse(String(ev.data));
  if (parsed && typeof parsed === "object" && typeof (parsed as Frame).type === "string") frames.push(parsed as Frame);
};
const opened = Promise.withResolvers<void>();
ws.onopen = () => opened.resolve();
ws.onerror = () => opened.reject(new Error("ws 连接失败"));
await opened.promise.catch((e) => fail(String(e)));
await waitType("ready");

// ---------- 1. host CRUD over ssh.json ----------
let mark = frames.length;
ws.send(JSON.stringify({ type: "ssh_save_host", name: "smoke-host", host: "127.0.0.1", port: 9, username: "u1", description: "smoke" }));
let hostsFrame = await waitType("ssh_hosts", mark).catch((e) => fail(String(e)));
let row = hostRows(hostsFrame).find((h) => h.name === "smoke-host");
assert(
  !!row && asText(row!.host) === "127.0.0.1" && asNum(row!.port) === 9 && asText(row!.username) === "u1",
  "ssh_save_host 新增后 ssh_hosts 返回该主机",
);
assert(readFileSync(sshJsonPath, "utf8").includes('"smoke-host"'), "ssh.json 落盘包含 smoke-host");

mark = frames.length;
ws.send(JSON.stringify({ type: "ssh_save_host", name: "smoke-host", host: "127.0.0.1", port: 10 }));
hostsFrame = await waitType("ssh_hosts", mark).catch((e) => fail(String(e)));
row = hostRows(hostsFrame).find((h) => h.name === "smoke-host");
assert(
  !!row && asNum(row!.port) === 10 && row!.username === undefined,
  "ssh_save_host 同名更新（port 覆盖、空字段清除）",
);

// ---------- 2. probe failure path (closed port) ----------
mark = frames.length;
ws.send(JSON.stringify({ type: "ssh_test_host", name: "smoke-host" }));
let probe = await waitType("ssh_test_result", mark, 30_000).catch((e) => fail(String(e)));
assert(frameField(probe, "ok") === false && asText(frameField(probe, "error")).length > 0, "ssh_test_host 对关闭端口返回 ok:false + error");

// ---------- 3. workspace path validation ----------
mark = frames.length;
ws.send(JSON.stringify({ type: "add_remote_workspace", host: "smoke-host", remotePath: "relative/path" }));
const errFrame = await waitType("error", mark).catch((e) => fail(String(e)));
assert(asText(frameField(errFrame, "message")).includes("relative/path"), "add_remote_workspace 相对路径被拒绝（错误帧）");

// ---------- 4. E2E leg against the lab sshd ----------
labOk = hasLabSshd && startLabSshd();
if (!labOk) console.log("… 跳过 lab sshd E2E 段（本机无 Git sshd 或启动失败）");
if (labOk) {
  const keyWin = join(LAB_ROOT, "client_key");
  mark = frames.length;
  ws.send(JSON.stringify({ type: "ssh_save_host", name: "lab-host", host: "127.0.0.1", port: SSHD_PORT, username: "XYS", keyPath: keyWin }));
  hostsFrame = await waitType("ssh_hosts", mark).catch((e) => fail(String(e)));
  assert(!!hostRows(hostsFrame).find((h) => h.name === "lab-host"), "lab-host 已保存");

  mark = frames.length;
  ws.send(JSON.stringify({ type: "ssh_test_host", name: "lab-host" }));
  probe = await waitType("ssh_test_result", mark, 30_000).catch((e) => fail(String(e)));
  assert(frameField(probe, "ok") === true && asNum(frameField(probe, "latencyMs"))! > 0, `ssh_test_host 对 lab sshd 探活成功（${asNum(frameField(probe, "latencyMs"))}ms；error=${asText(frameField(probe, "error"))}）`);

  const remotePath = "/tmp/omp-ssh-e2e";
  mark = frames.length;
  ws.send(JSON.stringify({ type: "add_remote_workspace", host: "lab-host", remotePath }));
  const added = await waitType("remote_workspace_added", mark, 30_000).catch((e) => fail(String(e)));
  const addedCwd = asText(frameField(added, "cwd"));
  assert(frameField(added, "ok") === true && addedCwd.length > 0, "add_remote_workspace 成功返回桩目录");
  stubDirs.push(addedCwd);
  const marker = JSON.parse(readFileSync(join(addedCwd, ".omp", "remote-workspace.json"), "utf8")) as Record<string, unknown>;
  assert(marker.host === "lab-host" && marker.remotePath === remotePath, "桩目录标记文件 host/remotePath 正确");

  // Missing remote dir → ok:false (probe rejects before stub creation)
  mark = frames.length;
  ws.send(JSON.stringify({ type: "add_remote_workspace", host: "lab-host", remotePath: "/tmp/omp-ssh-e2e-missing-xyz" }));
  const missing = await waitType("remote_workspace_added", mark, 30_000).catch((e) => fail(String(e)));
  assert(frameField(missing, "ok") === false && asText(frameField(missing, "error")).length > 0, "add_remote_workspace 远程目录不存在 → ok:false");

  // Session flow on the stub: register project, create a session, list back with remote fields
  mark = frames.length;
  ws.send(JSON.stringify({ type: "add_project", cwd: addedCwd }));
  await waitType("session_list", mark).catch((e) => fail(String(e)));
  mark = frames.length;
  ws.send(JSON.stringify({ type: "create_session", cwd: addedCwd }));
  const created = await waitType("session_created", mark, 30_000).catch((e) => fail(String(e)));
  assert(asText(frameField(created, "cwd")) === addedCwd && frameField(created, "isGit") === false, "create_session 在桩目录上成功（非 git）");
  mark = frames.length;
  ws.send(JSON.stringify({ type: "list_sessions" }));
  const list = await waitType("session_list", mark).catch((e) => fail(String(e)));
  const projects = Array.isArray(frameField(list, "projects")) ? (frameField(list, "projects") as Array<Record<string, unknown>>) : [];
  const proj = projects.find((p) => p.cwd === addedCwd);
  assert(
    !!proj && proj!.remote === true && proj!.remoteLabel === `lab-host:${remotePath}`,
    "session_list 项目行带 remote:true + remoteLabel",
  );
  // Tear the session down so the stub dir removal is clean
  mark = frames.length;
  ws.send(JSON.stringify({ type: "delete_session", path: asText(frameField(created, "path")) }));
  await waitType("session_list", mark).catch((e) => fail(String(e)));
}

// ---------- 5. removal ----------
mark = frames.length;
ws.send(JSON.stringify({ type: "ssh_remove_host", name: "smoke-host" }));
hostsFrame = await waitType("ssh_hosts", mark).catch((e) => fail(String(e)));
assert(!hostRows(hostsFrame).some((h) => h.name === "smoke-host"), "ssh_remove_host 后列表无该主机");
assert(!readFileSync(sshJsonPath, "utf8").includes('"smoke-host"'), "ssh.json 已移除 smoke-host");

clearTimeout(failTimeout);
ws.close();
restoreState();
console.log(labOk ? "全部断言通过（含 lab sshd E2E；profile 配置已还原）" : "基础断言通过（E2E 段跳过；profile 配置已还原）");
process.exit(0);
