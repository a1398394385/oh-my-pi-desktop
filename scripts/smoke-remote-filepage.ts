// Remote-workspace file-page smoke: exercises the host-side ssh branch of
// list_dir / read_file against a REAL remote workspace stub (real ssh, real
// `ls -1ap` / `cat` output), plus the resolveRemoteTarget translation and the
// untouched local-fs branch as a regression guard.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-remote-filepage.ts
process.env.OMP_PROFILE ||= "omp-desktop-test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Dynamic imports (static would hoist past the OMP_PROFILE assignment above):
// host modules resolve profile-dependent paths (agent dir, ssh.json, remote
// dir) at module-load time, so the env var must be set before they load.
const { getSSHConfigPath } = await import("@oh-my-pi/pi-utils");
const { readSSHConfigFile, addSSHHost, removeSSHHost } = await import("../host/bootstrap.ts");
const { ensureRemoteWorkspaceDir, resolveRemoteTarget, readUserSshHost } = await import("../host/remote-workspaces.ts");
const { filesHandlers } = await import("../host/rpc/files.ts");

const HOST = "test";
const REMOTE = "/Users/xys/etower/etower-agent";
const asserts: Array<[boolean, string]> = [];
const ok = (name: string, cond: boolean) => asserts.push([!!cond, name]);
type Frame = { type?: string; path?: string; text?: string; mime?: string; data?: string; entries?: Array<{ name: string; dir: boolean }> };
const fakeWs = (): { frames: Frame[]; ws: { send(s: string): void } } => {
  const frames: Frame[] = [];
  return { frames, ws: { send: (s: string) => frames.push(JSON.parse(s)) } };
};
// 1x1 transparent PNG used to exercise the remote read_image branch.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- Arrange: the test profile's ssh.json needs the real host entry ----
const sshJson = getSSHConfigPath("user");
const existing = (await readSSHConfigFile(sshJson)).hosts ?? {};
if (!existing[HOST]) await addSSHHost(sshJson, HOST, { host: "10.147.17.244", username: "xys" });

// ---- Arrange: materialize the real stub (deterministic dir + marker) ----
const stub = await ensureRemoteWorkspaceDir(HOST, REMOTE);

try {
  // ---- resolveRemoteTarget translation ----
  ok("桩根翻译: host 命中", resolveRemoteTarget(stub)?.host === HOST);
  ok("桩根翻译: remotePath 即远端根", resolveRemoteTarget(stub)?.remotePath === REMOTE);
  ok("子路径翻译 (/ 拼接)", resolveRemoteTarget(stub + "/packages")?.remotePath === `${REMOTE}/packages`);
  ok("子路径翻译 (\\ 混合, 前端树形态)", resolveRemoteTarget(stub + "\\packages\\core")?.remotePath === `${REMOTE}/packages/core`);
  ok("非桩本地路径返回 null", resolveRemoteTarget(path.join(os.tmpdir(), "plain-local")) === null);
  ok("特殊段 . .. 被丢弃不进入远端路径", resolveRemoteTarget(stub + "/./../y")?.remotePath === `${REMOTE}/y`);
  // ---- list_dir: ssh branch, stub root ----
  {
    const { frames, ws } = fakeWs();
    await filesHandlers.list_dir!(ws, { path: stub });
    const f = frames[0];
    ok("list_dir 桩根: 回 dir_list", f?.type === "dir_list");
    ok("list_dir 桩根: path 回显本地桩路径(前端缓存 key 不变)", f?.path === stub);
    const entries = f?.entries ?? [];
    ok("list_dir 桩根: 含目录 packages", entries.some((e) => e.name === "packages" && e.dir));
    ok("list_dir 桩根: 含文件 pnpm-workspace.yaml", entries.some((e) => e.name === "pnpm-workspace.yaml" && !e.dir));
    ok("list_dir 桩根: 过滤 .git / .DS_Store", !entries.some((e) => e.name === ".git" || e.name === ".DS_Store"));
    const firstFileIdx = entries.findIndex((e) => !e.dir);
    ok("list_dir 桩根: 目录排在文件前", firstFileIdx === -1 || entries.slice(0, firstFileIdx).every((e) => e.dir));
  }

  // ---- list_dir: ssh branch, nested level (frontend joins with "/") ----
  {
    const { frames, ws } = fakeWs();
    await filesHandlers.list_dir!(ws, { path: stub + "/packages" });
    const f = frames[0];
    ok("list_dir 子层: 回 dir_list", f?.type === "dir_list" && f?.path === stub + "/packages");
    ok("list_dir 子层: 非空", (f?.entries ?? []).length > 0);
  }

  // ---- read_file: ssh branch ----
  {
    const { frames, ws } = fakeWs();
    await filesHandlers.read_file!(ws, { path: stub + "/pnpm-workspace.yaml" });
    const f = frames[0];
    ok("read_file: 回 file_content", f?.type === "file_content");
    ok("read_file: path 回显本地桩路径", f?.path === stub + "/pnpm-workspace.yaml");
    ok("read_file: 内容含 packages 定义", typeof f?.text === "string" && f.text.includes("packages"));
    ok("read_file: 无 CRLF 篡改", typeof f?.text === "string" && !f.text.includes("\r\n"));
  }

  // ---- read_file: ssh branch, missing remote file surfaces the error ----
  {
    const { ws } = fakeWs();
    let threw = "";
    try {
      await filesHandlers.read_file!(ws, { path: stub + "/no-such-file-for-smoke.txt" });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok("read_file 远端缺文件: throw 且诊断含 no such file(zsh 小写)", threw.toLowerCase().includes("no such file"));
  }

  // ---- read_image: ssh branch (1x1 PNG staged on the remote, removed right after) ----
  {
    const { runSshCommand } = await import("../host/rpc/ssh.ts");
    const cfg = await readUserSshHost(HOST);
    if (!cfg) throw new Error("test 主机不在测试 profile ssh.json 中");
    const remoteTmp = `${REMOTE}/.omp-smoke-image.png`;
    await runSshCommand(cfg, `printf %s ${PNG_B64} | base64 -d > ${remoteTmp}`, 8_000);
    try {
      const { frames, ws } = fakeWs();
      await filesHandlers.read_image!(ws, { path: stub + "/.omp-smoke-image.png" });
      const f = frames[0];
      ok("read_image: 回 image_content", f?.type === "image_content");
      ok("read_image: mime 推断 png", f?.mime === "image/png");
      const data = typeof f?.data === "string" ? Buffer.from(f.data, "base64").subarray(0, 8) : null;
      ok("read_image: base64 去换行后可解出 PNG 魔数", !!data && data.equals(PNG_MAGIC));
    } finally {
      await runSshCommand(cfg, `rm -f ${remoteTmp}`, 8_000);
    }
  }

  // ---- Regression: local branch untouched ----
  {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "omp-smoke-filepage-"));
    fs.writeFileSync(path.join(local, "a.txt"), "local-branch", "utf8");
    fs.mkdirSync(path.join(local, "sub"), { recursive: true });
    const { frames, ws } = fakeWs();
    await filesHandlers.list_dir!(ws, { path: local });
    const names = (frames[0]?.entries ?? []).map((e) => e.name);
    ok("回归: 本地 list_dir 正常", frames[0]?.type === "dir_list" && names.includes("a.txt") && names.includes("sub"));
    await filesHandlers.read_file!(ws, { path: path.join(local, "a.txt") });
    ok("回归: 本地 read_file 正常", frames[1]?.text === "local-branch");
    fs.rmSync(local, { recursive: true, force: true });
  }
} finally {
  // Cleanup: stub dir + the host entry this smoke added (test profile only).
  fs.rmSync(stub, { recursive: true, force: true });
  if (!existing[HOST]) await removeSSHHost(sshJson, HOST);
}

let fail = 0;
for (const [cond, name] of asserts) {
  if (!cond) fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}
console.log(`\n${asserts.length - fail}/${asserts.length} 通过`);
process.exit(fail > 0 ? 1 : 0);
