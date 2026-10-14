// Smoke: fault-tolerance semantics of host/desktop-json.ts (ticket A1).
// Covers: absent file -> writeDesktopSection creates the initial structure;
// corrupt JSON / unreadable path (EISDIR) / non-object document ->
// writeDesktopSection refuses, on-disk bytes unchanged, stderr reports;
// valid file -> merge-write preserves sibling sections and unmentioned
// section fields. Runs entirely against a throwaway temp dir (no real
// profile is touched).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-desktop-json.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H } from "../host/state.ts";
import { readDesktopJson, readDesktopSection, writeDesktopSection, writeDesktopSections } from "../host/desktop-json.ts";

const dir = mkdtempSync(join(tmpdir(), "omp-desktop-json-smoke-"));
const cfgPath = join(dir, "omp-desktop.json");
H.desktopProjectsPath = cfgPath; // point the shared reader/writer at the throwaway file

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// Capture safeStderr output without polluting the real stderr
const origStderrWrite = process.stderr.write.bind(process.stderr);
let stderrOut = "";
(process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
  stderrOut += chunk;
  return true;
};
function takeStderr(): string {
  const out = stderrOut;
  stderrOut = "";
  return out;
}

try {
  // ---- 1. Absent file (ENOENT): legal empty state, write creates the file ----
  console.log("场景 1: 文件不存在(ENOENT)→ 正常创建初始结构");
  assert(readDesktopJson() !== null && Object.keys(readDesktopJson() as object).length === 0, "不存在的文件 readDesktopJson 返回空对象(合法空态,非 null)");
  assert(Object.keys(readDesktopSection("browser")).length === 0, "不存在的文件读取为空 section");
  writeDesktopSection("browser", { external: true });
  const created = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  assert((created.browser as Record<string, unknown>)?.external === true, "写入后文件被创建并含 browser section");
  assert(takeStderr() === "", "创建路径不产生 stderr 上报");

  // ---- 2. Corrupt JSON: write refuses, bytes unchanged, stderr reports ----
  console.log("场景 2: 文件损坏(非法 JSON)→ 拒绝写入 + stderr 上报 + 原字节不变");
  const corrupt = "{{{ definitely not json";
  writeFileSync(cfgPath, corrupt);
  assert(readDesktopJson() === null, "损坏文件 readDesktopJson 返回 null");
  assert(Object.keys(readDesktopSection("browser")).length === 0, "损坏文件读 section 容错为空对象(不抛)");
  writeDesktopSection("browser", { external: false });
  assert(readFileSync(cfgPath, "utf8") === corrupt, "拒绝写入后盘上原字节不变");
  const report = takeStderr();
  assert(report.includes("[desktop-json] refusing"), "stderr 含拒绝标记");
  assert(report.includes(cfgPath), "stderr 带文件路径");

  // ---- 3. Unreadable path (EISDIR via a directory standing in for the file): same refusal ----
  console.log("场景 3: 路径不可读(EISDIR)→ 同样拒绝写入");
  rmSync(cfgPath);
  mkdirSync(cfgPath); // a directory at the file path -> readFileSync throws EISDIR (same branch as EBUSY/EPERM)
  assert(readDesktopJson() === null, "不可读路径 readDesktopJson 返回 null");
  writeDesktopSection("computer", { defaultEnabled: true });
  assert(statSync(cfgPath).isDirectory(), "拒绝写入:路径未被文件覆盖");
  assert(takeStderr().includes("[desktop-json] refusing"), "stderr 含拒绝标记");
  rmSync(cfgPath, { recursive: true, force: true }); // remove the stand-in directory

  // ---- 4. Non-object document (valid JSON, wrong shape): treated as corrupt ----
  console.log("场景 4: 合法 JSON 但非对象(数组)→ 视为损坏,拒绝写入");
  const arrayDoc = '[1, 2, 3]';
  writeFileSync(cfgPath, arrayDoc);
  assert(readDesktopJson() === null, "非对象文档 readDesktopJson 返回 null");
  writeDesktopSection("browser", { external: true });
  assert(readFileSync(cfgPath, "utf8") === arrayDoc, "拒绝写入后盘上原字节不变");
  assert(takeStderr().includes("[desktop-json] refusing"), "stderr 含拒绝标记");

  // ---- 5. Valid file: merge-write preserves sibling sections; section-level
  // field preservation is the caller's read-modify-write job (that is how all
  // three consumers call it), so verify that pattern end-to-end ----
  console.log("场景 5: 合法文件 → 合并写保留兄弟 section;字段级保留走调用方 read-modify-write");
  writeFileSync(
    cfgPath,
    JSON.stringify({ acp: { enabled: true }, keepalive: { probe: 1 }, browser: { tern: "x" } }, null, 2),
  );
  writeDesktopSection("browser", { ...readDesktopSection("browser"), external: true });
  const merged = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  assert((merged.acp as Record<string, unknown>)?.enabled === true, "兄弟 section acp 保留");
  assert((merged.keepalive as Record<string, unknown>)?.probe === 1, "兄弟 section keepalive 保留");
  const browser = merged.browser as Record<string, unknown>;
  assert(browser.tern === "x" && browser.external === true, "read-modify-write 后未提及字段 tern 保留且 external 写入");
  // Without the read-modify-write the section is replaced wholesale:
  writeDesktopSection("browser", { cdpUrl: "y" });
  const after = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  const replaced = after.browser as Record<string, unknown>;
  assert(replaced.cdpUrl === "y" && !("tern" in replaced) && !("external" in replaced), "无 read-modify-write 时 section 整段替换(旧字段消失)");
  assert(takeStderr() === "", "合法写入不产生 stderr 上报");

  // ---- 6. writeDesktopSections (A2): multi-key overlay for saveDesktopProjects ----
  console.log("场景 6: writeDesktopSections 多 key overlay(A2)+ 损坏文件拒绝");
  writeFileSync(cfgPath, JSON.stringify({ acp: { enabled: true } }, null, 2));
  writeDesktopSections({ allProjects: ["/a"], removedProjects: [], browser: { external: true } });
  const overlay = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  assert((overlay.acp as Record<string, unknown>)?.enabled === true, "多 key overlay 保留兄弟 section acp");
  assert((overlay.browser as Record<string, unknown>)?.external === true, "patch 中的 key 落盘");
  assert(overlay.ui === undefined, "patch 之外的 key 不被引入(文件原样保留)");
  writeFileSync(cfgPath, "{{{ corrupt again");
  writeDesktopSections({ allProjects: ["/a"] });
  assert(readFileSync(cfgPath, "utf8") === "{{{ corrupt again", "损坏文件多 key overlay 同样拒绝写入、原字节不变");
  assert(takeStderr().includes("[desktop-json] refusing"), "多 key 拒绝路径 stderr 含拒绝标记");

  if (failures > 0) {
    console.error(`✗ desktop-json 冒烟失败:${failures} 项断言未过`);
    process.exit(1);
  }
  console.log("✓ desktop-json 容错语义冒烟全部通过");
} finally {
  (process.stderr as unknown as { write: typeof origStderrWrite }).write = origStderrWrite;
  rmSync(dir, { recursive: true, force: true });
}
