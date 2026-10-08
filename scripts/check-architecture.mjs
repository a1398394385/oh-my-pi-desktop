#!/usr/bin/env node
// Architecture ratchet gate (adapted from pi-desktop check-architecture for this repo's layout):
// 1. Hard caps for hot-spot files (SHRINK OR STAY STABLE: block growth, no retroactive relaxation on shrink):
//    host/main.ts <= 280 (after table-driven RPC, main only keeps the dispatch shell and host-level tasks), ui-src/store/session.ts <= 800; over the cap fails,
// 2. Line caps for newly added files: files added since the base commit (git diff --diff-filter=A)
//    are capped at 800 lines for TS/TSX and 1000 for Rust. Base defaults to main (--base <rev> or the env var
//    ARCHITECTURE_BASE can override; falls back to HEAD^ when the base is missing, and the new-file check is skipped when neither exists).
// Source roots: host/ ui-src/ scripts/ src-tauri/src/ (.mjs under scripts/ is uncapped -- gate/tool scripts are themselves exempt).
// Exempt dirs: build outputs such as node_modules/dist/target (ui/ docs/ .agents/ .local/ outside the source roots are naturally unchecked).
// Usage: node scripts/check-architecture.mjs [--base <rev>]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = process.cwd();
// Source roots and tracked extensions: scope = .ts/.tsx/.rs within the source roots (.mjs excluded from stats)
const sourceRoots = ["host", "ui-src", "scripts", "src-tauri/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".rs"]);
const excludedSegments = new Set(["node_modules", "dist", "out", "release", "target", "coverage"]);

// Hard caps for hot spots: no auto-tightening after a shrink (fixed-constant ratchet); over the cap fails
const HOT_LIMITS = [
  { path: "host/main.ts", max: 280 },
  { path: "ui-src/store/session.ts", max: 800 },
];

const CSS_LIMITS = {
  "global/animations.css": 70,
  "global/base.css": 30,
  "global/boot.css": 61,
  "global/context-card.css": 103,
  "global/controls.css": 330,
  "global/overlays.css": 140,
  "global/scrollbars.css": 40,
  "global/tokens.css": 240,
  "main/center.css": 100,
  "main/head-chips.css": 40,
  "main/chat/approval.css": 150,
  "main/chat/approval-collapse.css": 40,
  "main/chat/ask.css": 40,
  "main/chat/messages.css": 670,
  "main/chat/readonly-group.css": 100,
  "main/chat/status-find.css": 140,
  "main/chat/streamdown.css": 250,
  "main/composer-menus.css": 90,
  "main/composer.css": 680,
  "main/composer-bash.css": 110,
  "main/hub.css": 60,
  "main/right/background.css": 60,
  "main/right/branches.css": 20,
  "main/right/browser.css": 167,
  "main/right/capabilities.css": 70,
  "main/right/common.css": 190,
  "main/right/files.css": 30,
  "main/right/git.css": 60,
  "main/right/hub-detail.css": 70,
  "main/right/terminal.css": 190,
  "main/shell.css": 100,
  "main/sidebar.css": 653,
  "main/tree/fork.css": 60,
  "main/tree/stream.css": 299,
  "main/welcome.css": 215,
  "settings/agents.css": 20,
  "settings/appearance.css": 50,
  "settings/common.css": 600,
  "settings/experimental.css": 10,
  "settings/extensions.css": 140,
  "settings/forms.css": 100,
  "settings/hooks.css": 10,
  "settings/mcp.css": 300,
  "settings/memory.css": 80,
  "settings/models.css": 159,
  "settings/font-picker.css": 20,
  "settings/providers.css": 40,
  "settings/shortcuts.css": 20,
  "settings/skills.css": 280,
  "settings/shell.css": 50,
  "settings/stats-legacy.css": 50,
  "settings/stats-port.css": 1040,
  "settings/stats.css": 726,
  "shared/agent.css": 60,
  "shared/choice-pills.css": 90,
  "shared/code-blocks.css": 80,
  "shared/code-theme.css": 50,
  "shared/code-typography.css": 30,
  "shared/code-view.css": 60,
  "shared/markdown.css": 150,
  "shared/model-picker.css": 60,
};
for (const [path, max] of Object.entries(CSS_LIMITS)) HOT_LIMITS.push({ path: "ui/css/" + path, max });

function cssFiles(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir + "/" + entry.name;
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith(".css") ? [path] : [];
  });
}

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
// Non-source paths in HOT_LIMITS (e.g. .css) are not in sourceExtensions (kept out of the new-file check); fold them into line counting here
const styles = cssFiles("ui/css");
const locByPath = new Map([...files, ...styles, ...HOT_LIMITS.map((h) => h.path)].filter((p) => existsSync(resolve(root, p))).map((p) => [p, locFor(p)]));
const addedFiles = [...new Set([...addedSourceFiles(base), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(isSourcePath)])];
const failures = [];

for (const path of styles) {
  if (!(path.slice("ui/css/".length) in CSS_LIMITS)) failures.push(`${path} 未登记样式上限；新增 CSS 文件须登记`);
}

// ---- Check 1: hard caps for hot spots ----
for (const { path, max } of HOT_LIMITS) {
  const loc = locByPath.get(path);
  if (loc === undefined) {
    failures.push(`${path} 不存在（热区路径已变动？请同步 HOT_LIMITS）`);
  } else if (loc > max) {
    failures.push(`${path} 当前 ${loc} 行，超过上限 ${max} —— SHRINK OR STAY STABLE，先拆分再增长`);
  }
}

// ---- Check 2: line caps for newly added files (.d.ts declaration files unchecked) ----
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
