#!/usr/bin/env node
// 架构棘轮门禁（借鉴 pi-desktop check-architecture，适配本仓库目录）：
// 1. 热区文件硬上限（SHRINK OR STAY STABLE，只挡增长、不溯既往缩减）：
//    host/main.ts ≤ 280（RPC 查表化后 main 只剩分发壳与宿主级任务）、ui-src/store/session.ts ≤ 800，超限即挂；
// 2. 新增文件行数上限：相对基准 commit 新增（git diff --diff-filter=A）的文件
//    TS/TSX ≤ 800 行、Rust ≤ 1000 行。基准默认 main（--base <rev> 或环境变量
//    ARCHITECTURE_BASE 可覆盖；基准不存在时回退 HEAD^，均不可用时跳过新增检查）。
// 源根：host/ ui-src/ scripts/ src-tauri/src/（scripts/ 的 .mjs 不设限——门禁/工具脚本自身豁免）。
// 豁免目录：node_modules/dist/target 等构建产物（不在源根内的 ui/ docs/ .agents/ .local/ 天然不查）。
// 用法：node scripts/check-architecture.mjs [--base <rev>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = process.cwd();
// 源根与受限扩展名：统计范围 = 源根内 .ts/.tsx/.rs（.mjs 不进统计）
const sourceRoots = ["host", "ui-src", "scripts", "src-tauri/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".rs"]);
const excludedSegments = new Set(["node_modules", "dist", "out", "release", "target", "coverage"]);

// 热区硬上限：缩减后不自动收紧（固定常量棘轮），超限即挂
const HOT_LIMITS = [
  { path: "host/main.ts", max: 280 },
  { path: "ui-src/store/session.ts", max: 800 },
  // CSS 样式域（main.css 先按页面域切 5 份、main-chat 再按组件域切 4 份；域文件顺序 = 入口 @import 级联顺序；死类清理后收紧）
  { path: "ui/css/global.css", max: 880 },
  { path: "ui/css/main-shell.css", max: 170 },
  { path: "ui/css/main-sidebar.css", max: 810 },
  { path: "ui/css/main-chat.css", max: 960 },
  { path: "ui/css/main-composer.css", max: 670 },
  { path: "ui/css/main-streamdown.css", max: 280 },
  { path: "ui/css/main-tree.css", max: 450 },
  { path: "ui/css/main-welcome.css", max: 190 },
  { path: "ui/css/main-right.css", max: 1000 },
  { path: "ui/css/settings.css", max: 1420 },
];
const NEW_FILE_LIMITS = { ".ts": 800, ".tsx": 800, ".rs": 1000 };

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function isSourcePath(filePath) {
  const segments = filePath.split("/");
  if (
    segments.some((segment) => excludedSegments.has(segment)) ||
    !sourceRoots.some((sourceRoot) => filePath === sourceRoot || filePath.startsWith(sourceRoot + "/"))
  ) {
    return false;
  }
  return sourceExtensions.has(extname(filePath));
}

// 已跟踪 + 未忽略的未跟踪文件（git ls-files -co --exclude-standard）
function trackedSourceFiles() {
  return git(["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean).filter(isSourcePath);
}

function locFor(filePath) {
  const text = readFileSync(resolve(root, filePath), "utf8");
  const newlineCount = (text.match(/\n/g) || []).length;
  return newlineCount + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let base = process.env.ARCHITECTURE_BASE || "main";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--base") {
      base = args[i + 1];
      i += 1;
    }
  }
  return { base };
}

function revisionExists(revision) {
  try {
    git(["rev-parse", "--verify", revision]);
    return true;
  } catch {
    return false;
  }
}

function fallbackBase() {
  try {
    return git(["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
}

// 基准 commit 以来「本次新增」的源文件（含未提交时工作区对照：diff 亦覆盖工作区改动）
function addedSourceFiles(base) {
  if (!base) return [];
  return git(["diff", "--name-only", "--diff-filter=A", base]).split("\n").filter(Boolean).filter(isSourcePath);
}

const { base: requestedBase } = parseArgs();
const base = revisionExists(requestedBase) ? requestedBase : fallbackBase();
if (requestedBase && requestedBase !== base) {
  console.warn(`⚠ 基准 ${requestedBase} 不存在，新增文件检查回退到 ${base || "无基准（跳过）"}`);
}

const files = trackedSourceFiles();
// HOT_LIMITS 中的非源码路径（如 .css）不入 sourceExtensions（避免误入新文件检查），此处并入行数统计
const locByPath = new Map([...files, ...HOT_LIMITS.map((h) => h.path)].map((p) => [p, locFor(p)]));
const addedFiles = addedSourceFiles(base);
const failures = [];

// ---- 检查 1：热区硬上限 ----
for (const { path, max } of HOT_LIMITS) {
  const loc = locByPath.get(path);
  if (loc === undefined) {
    failures.push(`${path} 不存在（热区路径已变动？请同步 HOT_LIMITS）`);
  } else if (loc > max) {
    failures.push(`${path} 当前 ${loc} 行，超过上限 ${max} —— SHRINK OR STAY STABLE，先拆分再增长`);
  }
}

// ---- 检查 2：新增文件行数上限（.d.ts 声明文件不查）----
for (const path of addedFiles) {
  const max = NEW_FILE_LIMITS[extname(path)];
  const loc = locByPath.get(path) ?? locFor(path);
  if (max && loc > max && !path.endsWith(".d.ts")) {
    failures.push(`${path} 是新增文件，${loc} 行 > 上限 ${max}（${extname(path)} 新文件须 ≤ ${max} 行，拆分后再提交）`);
  }
}

const hotSummary = HOT_LIMITS.map(({ path, max }) => `${path} ${locByPath.get(path) ?? "?"}/${max}`).join("、");
if (failures.length > 0) {
  console.error(`✗ 架构门禁失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 架构门禁通过：源文件 ${files.length} 个；热区 ${hotSummary}；基准 ${base || "无"} 以来新增受检文件 ${addedFiles.length} 个`);
