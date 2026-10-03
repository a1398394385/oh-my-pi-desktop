#!/usr/bin/env node
// Host module boundary gate (minimal version borrowed from OBF check-core-boundaries):
// 1. Dependency direction table -- imports between modules in host/ may only use the edges declared in ALLOWED_EDGES;
//    everything else (including reverse deps on host.ts) is a violation, preventing a quiet regrow into a ball of mud after the split;
// 2. Orphan symbols -- every named symbol imported must have a matching export in the target module,
//    preventing a leftover import of a moved function from blowing up only at runtime.
// Parsing uses regexes (this repo's host modules are all named-export pure-function style, sufficient);
// limits/ is a vendor transplant and is not checked.
// Usage: node scripts/check-host-boundaries.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(root, "host");

// Allowed dependency edges (A -> B = A imports B). Update this table in sync with module structure changes and state the reason.
// host.ts is a thin entry (argv routing): the host body main.ts is loaded via dynamic import;
// dynamic imports are outside this table's scope; the host-body edges below are all static deps of main.ts.
const ALLOWED_EDGES = new Set([
  // ACP integration: host body main.ts mounts the acp panel; acp-tools/context depend on the shared acp-state (one-way downward)
  "main.ts→acp-state.ts", "main.ts→acp-context.ts", "main.ts→acp-tools.ts",
  "acp-context.ts→acp-state.ts", "acp-tools.ts→acp-state.ts", "acp-tools.ts→acp-context.ts",
  // Historical session retrieval tool (read_session_context): read-only over the current profile's on-disk sessions,
  // depends on the bootstrap SDK handles (listAllSessions / loadEntriesFromFile)
  "main.ts→session-context.ts", "session-context.ts→bootstrap.ts",
  // GUI env bootstrap: thin entry host.ts fires the PATH augment early
  // (overlapping main.ts's static graph load incl. the SDK); main.ts awaits
  // the same idempotent-singleton promise
  "host.ts→gui-path.ts", "main.ts→gui-path.ts",
  // Right-pane terminal: main.ts spawns the pty-bridge child process wrapper
  "main.ts→pty.ts",
  "main.ts→bootstrap.ts", "main.ts→state.ts", "main.ts→profile.ts", "main.ts→models.ts",
  "main.ts→assets.ts", "main.ts→stats.ts", "main.ts→translate.ts", "main.ts→limits",
  "profile.ts→state.ts", "profile.ts→bootstrap.ts", "profile.ts→models.ts",
  "models.ts→state.ts", "models.ts→bootstrap.ts",
  "assets.ts→state.ts", "assets.ts→bootstrap.ts", "assets.ts→profile.ts",
  "stats.ts→bootstrap.ts",
  // Extension center (transplanted from /extensions): extensions.ts gets SDK handles via bootstrap and reads H state;
  // main.ts mounts four RPC dispatches (same integration shape as assets.ts)
  "main.ts→extensions.ts", "extensions.ts→bootstrap.ts", "extensions.ts→state.ts",
  "translate.ts→state.ts",
  "state.ts→bootstrap.ts",
  // 18.5.0 settings registry adapter: dotted-path settings reads/writes route
  // through settings-compat.ts (registry handles obtained via bootstrap)
  "settings-compat.ts→bootstrap.ts",
  "main.ts→settings-compat.ts", "models.ts→settings-compat.ts", "assets.ts→settings-compat.ts",
  "frames.ts→settings-compat.ts", "extensions.ts→settings-compat.ts", "goal.ts→settings-compat.ts",
  "plan.ts→settings-compat.ts", "plan-approve.ts→settings-compat.ts", "profile.ts→settings-compat.ts",
  "rpc/assets.ts→settings-compat.ts", "rpc/models.ts→settings-compat.ts", "rpc/prompt.ts→settings-compat.ts",
  "rpc/settings.ts→settings-compat.ts", "rpc/settings.ts→bootstrap.ts",
  // Desktop implementation of the /goal command + goal-resume scheduling: main.ts mounts the command dispatch and event hooks;
  // state.ts's PoolEntry holds the controller instance (goal.ts depends only on its own narrow interface, one-way downward)
  "main.ts→goal.ts", "state.ts→goal.ts",
  // Strip ACP-injected tags: translate.ts consumes the REF_TAG_RE regex from acp-context.ts
  "translate.ts→acp-context.ts",
  // Shared MCP connection pool: main.ts drives lifecycle and RPC, depends on bootstrap's connectToServer and state
  "main.ts→mcp-pool.ts", "mcp-pool.ts→bootstrap.ts", "mcp-pool.ts→state.ts",
  // Plan mode domain: main.ts mounts the /plan dispatch and the plan_mode RPC; approval/output bridges and event stamps live in state
  "main.ts→plan.ts", "plan.ts→bootstrap.ts", "plan.ts→state.ts",
  // Plan approval flow (the five next-step options + execution-model slider): plan.ts installs the
  // xd://propose handler, session-lifecycle owns the event subscription that dispatches the approval
  // out of band. plan-approve gets its fresh-session factory INJECTED by session-lifecycle rather
  // than importing it back — the dependency is one-way by construction, so no cycle enters the table.
  "plan.ts→plan-approve.ts", "plan-approve.ts→bootstrap.ts", "plan-approve.ts→state.ts",
  "session-lifecycle.ts→plan-approve.ts", "rpc/settings.ts→plan-approve.ts",
  // Session lifecycle domain: main.ts mounts the create/load dispatches; the lifecycle depends on plan (restoring plan mode),
  // queue (queued-race fallback), profile (experiment switches), assets (plugin/hook switches)
  "main.ts→session-lifecycle.ts",
  "session-lifecycle.ts→state.ts", "session-lifecycle.ts→bootstrap.ts",
  "session-lifecycle.ts→goal.ts", "session-lifecycle.ts→acp-state.ts",
  "session-lifecycle.ts→acp-context.ts", "session-lifecycle.ts→acp-tools.ts",
  "session-lifecycle.ts→session-context.ts", "session-lifecycle.ts→translate.ts",
  "session-lifecycle.ts→profile.ts", "session-lifecycle.ts→assets.ts",
  "session-lifecycle.ts→queue.ts", "session-lifecycle.ts→plan.ts",
  // Cache keepalive (an inline-extension domain conditionally injected behind an experiment switch, same precedent as acp-context;
  // three flat files keepalive/keepalive-config/keepalive-lib)
  "session-lifecycle.ts→keepalive.ts",
  "session-lifecycle.ts→keepalive-config.ts",
  "keepalive.ts→keepalive-config.ts", "keepalive.ts→keepalive-lib.ts",
  // Config source of truth = the keepalive section of omp-desktop.json (per-profile independent); reads/writes go through state.ts's H
  "keepalive-config.ts→state.ts",
  // UI config persistence (omp-desktop.json ui section: locale/theme/motion/prefs):
  // applyProfile re-reads the locale on every profile apply; the set_locale /
  // set_ui_prefs RPCs write it; frames.ts carries the readUiConfig projection;
  // read/write goes through state.ts's H (same as keepalive-config)
  "profile.ts→ui-config.ts", "rpc/settings.ts→ui-config.ts", "ui-config.ts→state.ts",
  "frames.ts→ui-config.ts",
  // Queued message domain: followUp/steering views, park staging plus send-now/requeue/drop
  "main.ts→queue.ts", "queue.ts→bootstrap.ts", "queue.ts→state.ts",
  // Experiment switches (acp/sessionContext section) live in omp-desktop.json alongside the profile
  "profile.ts→acp-state.ts",
  // Frame assembly layer: models/settings frames are shared by multiple rpc domains and main's ready frame
  // (why it is its own layer: settingsFrame combines the models snapshot with profile/assets switches; sinking into either side would create a cycle)
  "main.ts→frames.ts",
  "frames.ts→state.ts", "frames.ts→models.ts", "frames.ts→profile.ts", "frames.ts→assets.ts",
  "frames.ts→keepalive-config.ts", // The settings frame carries state.json probe params (feature-page configuration for experiments)
  // Nine RPC handler domains (third cut: the giant message switch became table-driven): main keeps only the dispatch shell
  "main.ts→rpc/index.ts",
  "rpc/index.ts→rpc/types.ts",
  "rpc/index.ts→rpc/session.ts", "rpc/index.ts→rpc/prompt.ts", "rpc/index.ts→rpc/files.ts",
  "rpc/index.ts→rpc/models.ts", "rpc/index.ts→rpc/settings.ts", "rpc/index.ts→rpc/login.ts",
  "rpc/index.ts→rpc/assets.ts", "rpc/index.ts→rpc/terminal.ts", "rpc/index.ts→rpc/limits.ts",
  "rpc/session.ts→rpc/types.ts",
  "rpc/session.ts→bootstrap.ts", "rpc/session.ts→state.ts", "rpc/session.ts→profile.ts",
  "rpc/session.ts→translate.ts", "rpc/session.ts→session-lifecycle.ts",
  // Session activity time (list/branch rows): the SDK reports `modified` as the
  // file mtime, which a `session_exit` diagnostic frame refreshes, so
  // rpc/session.ts rewrites it to the last `message` frame's timestamp
  "rpc/session.ts→session-activity.ts",
  "rpc/prompt.ts→rpc/types.ts", "rpc/prompt.ts→rpc/session.ts",
  "rpc/prompt.ts→bootstrap.ts", "rpc/prompt.ts→state.ts", "rpc/prompt.ts→translate.ts",
  "rpc/prompt.ts→session-lifecycle.ts", "rpc/prompt.ts→plan.ts", "rpc/prompt.ts→queue.ts",
  "rpc/files.ts→rpc/types.ts", "rpc/files.ts→state.ts", "rpc/files.ts→session-lifecycle.ts",
  "rpc/models.ts→rpc/types.ts", "rpc/models.ts→bootstrap.ts", "rpc/models.ts→state.ts",
  "rpc/models.ts→models.ts", "rpc/models.ts→frames.ts", "rpc/models.ts→limits",
  "rpc/models.ts→stats.ts",
  "rpc/settings.ts→rpc/types.ts", "rpc/settings.ts→rpc/session.ts",
  "rpc/settings.ts→state.ts", "rpc/settings.ts→models.ts", "rpc/settings.ts→frames.ts",
  "rpc/settings.ts→profile.ts", "rpc/settings.ts→assets.ts", "rpc/settings.ts→plan.ts",
  "rpc/settings.ts→keepalive-config.ts", // set_keepalive_config merges into state.json
  "rpc/login.ts→rpc/types.ts", "rpc/login.ts→bootstrap.ts", "rpc/login.ts→state.ts",
  "rpc/login.ts→models.ts", "rpc/login.ts→frames.ts",
  "rpc/assets.ts→rpc/types.ts", "rpc/assets.ts→bootstrap.ts", "rpc/assets.ts→state.ts",
  "rpc/assets.ts→assets.ts", "rpc/assets.ts→profile.ts", "rpc/assets.ts→extensions.ts",
  "rpc/assets.ts→models.ts", "rpc/assets.ts→frames.ts",
  "rpc/terminal.ts→rpc/types.ts", "rpc/terminal.ts→pty.ts",
  "rpc/limits.ts→rpc/types.ts", "rpc/limits.ts→bootstrap.ts", "rpc/limits.ts→state.ts",
  "rpc/limits.ts→limits",
  // Session capabilities snapshot domain (right-panel page): state sources via bootstrap,
  // pool state via state.ts; session-lifecycle pushes the MCP incremental frame
  "capabilities.ts→bootstrap.ts", "capabilities.ts→state.ts",
  "session-lifecycle.ts→capabilities.ts",
  "rpc/capabilities.ts→rpc/types.ts", "rpc/capabilities.ts→state.ts",
  "rpc/capabilities.ts→capabilities.ts",
  "rpc/index.ts→rpc/capabilities.ts",
]);

// Scan one level of host/ plus the host/rpc/ subdirectory (keys carry a path prefix like rpc/session.ts)
const files = [
  ...readdirSync(hostDir).filter((f) => f.endsWith(".ts")),
  ...readdirSync(join(hostDir, "rpc")).filter((f) => f.endsWith(".ts")).map((f) => `rpc/${f}`),
];
const exportsOf = {}; // file -> full set of named exports
const importsOf = {}; // file -> [{ target, symbols, typeOnly }]

for (const f of files) {
  const src = readFileSync(join(hostDir, f), "utf8");
  const exported = new Set();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    exported.add(m[1]);
  }
  // top-level await destructuring export: export const { a, b: c } = await import("...")
  for (const m of src.matchAll(/export\s+const\s*\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s*:\s*/).pop()?.trim(); // for the a: b form the export name is b
      if (name) exported.add(name);
    }
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exported.add(name);
    }
  }
  exportsOf[f] = exported;

  importsOf[f] = [];
  // Only relative imports (./ ../) are checked; external packages (@oh-my-pi/*, node:*) are not in the boundary table
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s*from\s*"(\.\.?\/)([^"]+)"/g)) {
    const typeOnly = !!m[1];
    const symbols = [...m[2].split(",")].map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean);
    const prefix = m[3];
    let target = m[4].replace(/\.ts$/, "");
    if (target.startsWith("limits")) continue; // vendor transplant
    // ../x = back to the host root; ./x = relative to the current file's directory
    const base = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    if (prefix === "../") target = `${target}.ts`;
    else target = `${base}${target}${target.includes(".") ? "" : ".ts"}`;
    importsOf[f].push({ target, symbols, typeOnly });
  }
}

const problems = [];
for (const [file, imports] of Object.entries(importsOf)) {
  for (const imp of imports) {
    // Relative imports resolving outside host/ (e.g. ../ui-src/i18n/host.ts ->
    // "ui-src/i18n/host.ts") are not governed by this table: it only constrains
    // edges between host/ modules (top level + rpc/). Skip before the edge check
    // so out-of-tree imports neither need allow-listing nor trip the
    // "nonexistent module" probe (only host/ files are scanned for exports).
    if (imp.target.includes("/") && !imp.target.startsWith("rpc/")) continue;
    const edge = `${file}→${imp.target}`;
    if (!ALLOWED_EDGES.has(edge)) {
      problems.push(`非法依赖边: ${edge}（不在 ALLOWED_EDGES，改结构须同步表并附理由）`);
      continue;
    }
    // Orphan symbols: the target file must actually export these names (type-only imports checked too, guarding against slips)
    const targetExports = exportsOf[imp.target];
    if (!targetExports) {
      problems.push(`依赖边指向不存在的模块: ${edge}`);
      continue;
    }
    for (const sym of imp.symbols) {
      if (!targetExports.has(sym)) problems.push(`孤儿符号: ${file} import { ${sym} } 但 ${imp.target} 未导出`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ host 模块边界违规（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ host 模块边界干净：${ALLOWED_EDGES.size} 条声明边全部成立，无孤儿符号`);
