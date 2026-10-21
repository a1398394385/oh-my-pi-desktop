#!/usr/bin/env node
// Architecture line-budget gate (adapted from pi-desktop check-architecture for this repo's layout).
// Policy history: a per-file "shrink or stay stable" ratchet was replaced on 2026-10-21 — it
// froze each file at split size, so a 3-line edit forced a 50-line extraction. Now:
// 1. Domain budgets: files of one domain grow freely, their sum is capped (DOMAIN_BUDGETS);
// 2. Explicit thin files (FILE_CAPS) — the RPC dispatch shell must stay small;
// 3. Global bounds: FILE_SOFT_CAP warns (only for files touched in this change), FILE_HARD_CAP fails;
// 4. Line caps for newly added files: files added since the base commit (git diff --diff-filter=A)
//    are capped at 700 lines for TS/TSX and 1000 for Rust. Base defaults to main (--base <rev> or the env var
//    ARCHITECTURE_BASE can override; falls back to HEAD^ when the base is missing, and the new-file check is skipped when neither exists).
// Source roots: host/ ui-src/ scripts/ src-tauri/src/ (.mjs under scripts/ is uncapped -- gate/tool scripts are themselves exempt).
// Exempt dirs: build outputs such as node_modules/dist/target (ui/ docs/ .agents/ .local/ outside the source roots are naturally unchecked).
// Usage: node scripts/check-architecture.mjs [--base <rev>]
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = process.cwd();
// Source roots and tracked extensions: scope = .ts/.tsx/.rs within the source roots (.mjs excluded from stats)
const sourceRoots = ["host", "ui-src", "scripts", "src-tauri/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".rs"]);
const excludedSegments = new Set(["node_modules", "dist", "out", "release", "target", "coverage"]);

// Line-budget policy (replaced the per-file "shrink or stay stable" ratchet, 2026-10-21):
// a flat per-file ceiling punished correct small edits while the real structural guard is
// check-host-boundaries.mjs. Three layers now:
//   1. DOMAIN_BUDGETS — files of one domain grow freely, but their total is capped;
//   2. FILE_CAPS — the few files that must stay thin regardless of their domain;
//   3. FILE_SOFT_CAP (warn) / FILE_HARD_CAP (fail) — the outer bounds for every file.
// i18n locale tables are data, not logic, and stay exempt.
const FILE_CAPS = [
  { path: "host/main.ts", max: 280 }, // RPC dispatch shell: table-driven, never grows
];

const DOMAIN_BUDGETS = [
  // Session lifecycle domain (lifecycle / entry wiring / snapshot / context / titles):
  // members may grow, the sum may not. Current 1966 across 8 files (2026-10-21).
  { note: "会话生命周期域", match: /^host\/session-.*\.ts$/, max: 2200 },
];

const FILE_SOFT_CAP = 700;
const FILE_HARD_CAP = 1500;
const LOC_EXEMPT = [/^ui-src\/i18n\/locales\//];

const NEW_FILE_LIMITS = { ".ts": 700, ".tsx": 700, ".rs": 1000 };

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

// Tracked + non-ignored untracked files (git ls-files -co --exclude-standard)
function trackedSourceFiles() {
  return git(["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean).filter(isSourcePath).filter((path) => existsSync(resolve(root, path)));
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

// Source files newly added since the base commit (uncommitted workspace included: diff also covers working-tree changes)
function addedSourceFiles(base) {
  if (!base) return [];
  return git(["diff", "--name-only", "--diff-filter=A", base]).split("\n").filter(Boolean).filter(isSourcePath).filter((path) => existsSync(resolve(root, path)));
}

const { base: requestedBase } = parseArgs();
const base = revisionExists(requestedBase) ? requestedBase : fallbackBase();
if (requestedBase && requestedBase !== base) {
  console.warn(`⚠ 基准 ${requestedBase} 不存在，新增文件检查回退到 ${base || "无基准（跳过）"}`);
}

const files = trackedSourceFiles();
const locByPath = new Map([...files, ...FILE_CAPS.map((h) => h.path)].filter((p) => existsSync(resolve(root, p))).map((p) => [p, locFor(p)]));
const addedFiles = [...new Set([...addedSourceFiles(base), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(isSourcePath)])];
const failures = [];
const warnings = [];
const locOf = (path) => locByPath.get(path) ?? locFor(path);
// Soft-cap notices fire only for files this change touches: a standing list of every historical
// oversized file would train people to ignore the whole gate.
const touched = new Set(
  [
    ...(base ? git(["diff", "--name-only", base]).split("\n") : []),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean),
);

// ---- Check 1: single-file caps (explicit thin files, then the global soft/hard bounds) ----
for (const { path, max } of FILE_CAPS) {
  const loc = locByPath.get(path);
  if (loc === undefined) {
    failures.push(`${path} 不存在（显式上限路径已变动？请同步 FILE_CAPS）`);
  } else if (loc > max) {
    failures.push(`${path} 当前 ${loc} 行，超过显式上限 ${max}（该文件必须保持薄）`);
  }
}
for (const path of files) {
  if (LOC_EXEMPT.some((re) => re.test(path))) continue;
  const loc = locOf(path);
  if (loc > FILE_HARD_CAP) {
    failures.push(`${path} 当前 ${loc} 行，超过硬顶 ${FILE_HARD_CAP} —— 拆分后再提交`);
  } else if (loc > FILE_SOFT_CAP && touched.has(path)) {
    warnings.push(`${path} ${loc} 行（软线 ${FILE_SOFT_CAP}，可继续，但优先按职责拆分）`);
  }
}

// ---- Check 2: domain budgets (members grow freely, the domain total does not) ----
for (const { note, match, max } of DOMAIN_BUDGETS) {
  const members = files.filter((p) => match.test(p));
  const total = members.reduce((n, p) => n + locOf(p), 0);
  if (total > max) {
    const detail = members.map((p) => `${p} ${locOf(p)}`).join("、");
    failures.push(`${note}：合计 ${total} 行，超过域预算 ${max}（${detail}）—— 域内先腾空间或新开文件归入其它域`);
  }
}

// ---- Check 3: line caps for newly added files (.d.ts declaration files unchecked) ----
for (const path of addedFiles) {
  const max = NEW_FILE_LIMITS[extname(path)];
  const loc = locByPath.get(path) ?? locFor(path);
  if (max && loc > max && !path.endsWith(".d.ts")) {
    failures.push(`${path} 是新增文件，${loc} 行 > 上限 ${max}（${extname(path)} 新文件须 ≤ ${max} 行，拆分后再提交）`);
  }
}

const domainSummary = DOMAIN_BUDGETS.map(({ note, match, max }) => {
  const total = files.filter((p) => match.test(p)).reduce((n, p) => n + locOf(p), 0);
  return `${note} ${total}/${max}`;
}).join("、");
if (failures.length > 0) {
  console.error(`✗ 架构门禁失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (warnings.length > 0) {
  console.warn(`⚠ 软线告警（不影响通过，共 ${warnings.length} 项）：`);
  for (const w of warnings) console.warn(`  - ${w}`);
}
console.log(`✓ 架构门禁通过：源文件 ${files.length} 个；域预算 ${domainSummary}；单文件软线 ${FILE_SOFT_CAP}/硬顶 ${FILE_HARD_CAP}；基准 ${base || "无"} 以来新增受检文件 ${addedFiles.length} 个`);
