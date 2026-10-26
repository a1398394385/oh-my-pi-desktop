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
  // ACP dual-zone compaction (spec §9): persistence/rebuild layer reuses the T1
  // projection shapes; acp-projection stays a pure leaf — its only non-local
  // dep is the pure messageFingerprint helper (T4 token memo keys), kept in
  // the leaf acp-fingerprint.ts after the nudge prototype retirement (T10).
  "acp-persist.ts→acp-projection.ts", "acp-projection.ts→acp-fingerprint.ts",
  // ACP runtime (T3): session-lifecycle assembles compress_context + the
  // dual-zone projection from acp-runtime; it reuses the T1/T2 shapes and the
  // prototype's messageFingerprint for view<->entry-id alignment. T7 adds the
  // restart-rebuild edge: session-lifecycle adopts the rebuilt zone/compressed
  // set (or degrades on a base compaction entry) straight from acp-persist,
  // and the §5.2 decision table + §11 params moved to the pure leaf acp-plan
  // (single decision source for runtime, assembly, and smokes).
  "session-lifecycle.ts→acp-runtime.ts", "session-lifecycle.ts→acp-persist.ts", "session-lifecycle.ts→acp-plan.ts",
  "acp-runtime.ts→acp-projection.ts", "acp-runtime.ts→acp-plan.ts",
  "acp-runtime.ts→acp-persist.ts", "acp-runtime.ts→stderr.ts",
  // (acp-recall-tool.ts removed v12-2026-10-26: recall_block dropped, 0 uses / 84 blocks)
  // T11 acp-runtime split (pure refactor): the §6 compress validation/planning
  // moved to acp-compress (pure over plan/projection/persist shapes), and the
  // assembly layer (runtime factory + tool/extension definitions) to
  // acp-assembly; acp-runtime re-exports the assembly symbols so the frozen
  // smoke scripts keep resolving — an intentional runtime↔assembly cycle,
  // safe because assembly only touches the class at call time. session-lifecycle
  // now imports the assembly layer directly.
  "session-lifecycle.ts→acp-assembly.ts", "acp-runtime.ts→acp-compress.ts",
  "acp-runtime.ts→acp-assembly.ts", "acp-assembly.ts→acp-runtime.ts",
  "acp-compress.ts→acp-plan.ts", "acp-compress.ts→acp-projection.ts",
  "acp-compress.ts→acp-persist.ts", "acp-assembly.ts→acp-plan.ts",
  "acp-assembly.ts→acp-persist.ts", "acp-assembly.ts→stderr.ts",
  // ACP v10 (pull mode + short refs): the bN registry + view alignment live in
  // acp-refs (journal-replayed, pure over projection/persist shapes); the
  // context_status tool surface + the status/ephemeral renders live in
  // acp-status-tool (AcpParams from the plan leaf; the runtime feeds it
  // AcpRoundStatus structurally, no reverse edge).
  "acp-runtime.ts→acp-refs.ts", "acp-refs.ts→acp-projection.ts",
  "acp-refs.ts→acp-persist.ts", "acp-refs.ts→acp-fingerprint.ts",
  "acp-runtime.ts→acp-status-tool.ts", "acp-status-tool.ts→acp-plan.ts",
  "session-lifecycle.ts→acp-status-tool.ts",
  // 18.5 background jobs (auto-backgrounded bash/eval + background task tools):
  // async-jobs.ts is the pure bg_jobs payload/correction module; rpc/session replies
  // with it and session-lifecycle pushes the load backlog + turn_start correction
  "async-jobs.ts→state.ts", "session-lifecycle.ts→async-jobs.ts", "rpc/session.ts→async-jobs.ts",
  // Historical session retrieval tool (read_session_context): read-only over the current profile's on-disk sessions,
  // depends on the bootstrap SDK handles (listAllSessions / loadEntriesFromFile)
  "main.ts→session-context.ts", "session-context.ts→bootstrap.ts",
  // Sidebar full-text search (search_session_text): consumes the retrieval tool's exported scan/search core
  // (scanSessions + searchSessionContext) — one parse path and one ranking for both consumers, no second parse layer
  "rpc/session.ts→session-text-search.ts", "session-text-search.ts→session-context.ts",
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
  // Stats dashboard judge: profile.ts hands the host's settings + model registry to
  // stats-judge.ts, which registers the judge omp-stats' frustration classification needs.
  "profile.ts→stats-judge.ts", "stats-judge.ts→bootstrap.ts", "stats-judge.ts→stderr.ts",
  // ACP compaction gain (stats Gain page): acp-gain scans the profile's session journals
  // and needs the SDK's session dir path from bootstrap (getSessionsDir).
  "acp-gain.ts→bootstrap.ts", "stats.ts→acp-gain.ts",
  // Extension center (transplanted from /extensions): extensions.ts gets SDK handles via bootstrap and reads H state;
  // main.ts mounts four RPC dispatches (same integration shape as assets.ts)
  "main.ts→extensions.ts", "extensions.ts→bootstrap.ts", "extensions.ts→state.ts",
  "translate.ts→state.ts",
  "state.ts→bootstrap.ts",
  // Safe stderr logging (EPIPE-swallowing wrapper): every host module that
  // logs to the shell pipe goes through safeStderr, so a dead parent shell
  // can no longer turn a log line into an unhandled rejection that drags the
  // host into fork-inducing fatal teardown (2026-10-05 session-duplication
  // incident). Leaf utility: imports nothing.
  "assets.ts→stderr.ts", "bootstrap.ts→stderr.ts", "browser-mirror.ts→stderr.ts", // A4: mirror poll failure reporting
  "gui-path.ts→stderr.ts",
  "desktop-json.ts→stderr.ts", // A1: refuses merge-write over an unreadable/corrupt omp-desktop.json
  "editors.ts→stderr.ts", // editor icon decode failures land on stderr only (best-effort icon path)
  "keepalive.ts→stderr.ts", "main.ts→stderr.ts", "mcp-mount.ts→stderr.ts", "mcp-pool.ts→stderr.ts",
  "plan-approve.ts→stderr.ts", "profile.ts→stderr.ts", "session-lifecycle.ts→stderr.ts",
  "stats.ts→stderr.ts", // A6: rejected CORS origins are logged for misfire diagnosis
  "rpc/login.ts→stderr.ts", "rpc/models.ts→stderr.ts", "rpc/prompt.ts→stderr.ts",
  "rpc/assets.ts→stderr.ts",
  "rpc/session.ts→stderr.ts", "rpc/settings.ts→stderr.ts",
  // 18.5.0 settings registry adapter: dotted-path settings reads/writes route
  // through settings-compat.ts (registry handles obtained via bootstrap)
  "settings-compat.ts→bootstrap.ts",
  "main.ts→settings-compat.ts", "models.ts→settings-compat.ts", "assets.ts→settings-compat.ts",
  "frames.ts→settings-compat.ts", "extensions.ts→settings-compat.ts", "goal.ts→settings-compat.ts",
  "plan.ts→settings-compat.ts", "plan-approve.ts→settings-compat.ts", "profile.ts→settings-compat.ts",
  "session-lifecycle.ts→settings-compat.ts", // context_status sizes its return under tools.artifactSpillThreshold
  "rpc/assets.ts→settings-compat.ts", "rpc/models.ts→settings-compat.ts", "rpc/prompt.ts→settings-compat.ts",
  // rpc/prompt's list_commands decides the new-session sentinel path via the plugins master switch (readPluginsEnabled)
  "rpc/prompt.ts→assets.ts",
  "rpc/settings.ts→settings-compat.ts", "rpc/settings.ts→bootstrap.ts",
  // Desktop implementation of the /goal command + goal-resume scheduling: main.ts mounts the command dispatch and event hooks;
  // state.ts's PoolEntry holds the controller instance (goal.ts depends only on its own narrow interface, one-way downward)
  "main.ts→goal.ts", "state.ts→goal.ts",
  // (REF_TAG_RE was inlined into translate.ts at the T10 prototype retirement)
  // Shared MCP connection pool: main.ts drives lifecycle and RPC, depends on bootstrap's connectToServer and state
  "main.ts→mcp-pool.ts", "mcp-pool.ts→bootstrap.ts", "mcp-pool.ts→state.ts",
  // Session-bound MCP mounting (pool-lifecycle boundaries): mcp-mount owns the
  // per-session tool-surface mounts; it computes visibility from assets' scan,
  // acquires from the pool, and reads/stamps state. Consumers: session-lifecycle
  // (create + switch-back mount), rpc/assets (mcp_detach), rpc/session
  // (delete/reload release), capabilities (registry snapshot).
  "mcp-mount.ts→bootstrap.ts", "mcp-mount.ts→mcp-pool.ts", "mcp-mount.ts→assets.ts", "mcp-mount.ts→state.ts",
  "session-lifecycle.ts→mcp-mount.ts", "rpc/assets.ts→mcp-mount.ts", "rpc/session.ts→mcp-mount.ts",
  "capabilities.ts→mcp-mount.ts",
  // Code-owned builtin MCP servers (computer-use kimi-cu): mcp-builtin holds
  // the definitions + the pool warm-up (never read from or written to
  // mcp.json; a same-named user entry is shadowed). mcp-mount resolves
  // builtins first on the mid-session mount path; rpc/assets' test_kimi_cu
  // probes via the warm; frames carries the install probe for the option gate.
  "mcp-builtin.ts→assets.ts", "mcp-builtin.ts→mcp-pool.ts", "mcp-builtin.ts→state.ts", "mcp-builtin.ts→stderr.ts",
  "mcp-mount.ts→mcp-builtin.ts", "rpc/assets.ts→mcp-builtin.ts", "frames.ts→mcp-builtin.ts",
  // Plan mode domain: main.ts mounts the /plan dispatch and the plan_mode RPC; approval/output bridges and event stamps live in state
  "main.ts→plan.ts", "plan.ts→bootstrap.ts", "plan.ts→state.ts",
  // Plan approval flow (the five next-step options + execution-model slider): plan.ts installs the
  // xd://propose handler, session-lifecycle owns the event subscription that dispatches the approval
  // out of band. plan-approve gets its fresh-session factory INJECTED by session-lifecycle rather
  // than importing it back — the dependency is one-way by construction, so no cycle enters the table.
  "plan.ts→plan-approve.ts", "plan-approve.ts→bootstrap.ts", "plan-approve.ts→state.ts",
  "session-lifecycle.ts→plan-approve.ts", "rpc/settings.ts→plan-approve.ts",
  // Computer-use session state (the composer's screen-icon toggle): push/set
  // mirror plan.ts's frame contract; the pinned overlay lives in the session
  // settings child, the master gate in H.settings (bootstrap lookup).
  "computer-mode.ts→bootstrap.ts", "computer-mode.ts→state.ts", "computer-mode.ts→settings-compat.ts",
  // advisor-mode mirrors the computer-mode seam (header eye frame + per-session toggle)
  "advisor-mode.ts→state.ts", "advisor-mode.ts→i18n/host.ts",
  "session-lifecycle.ts→advisor-mode.ts", "rpc/settings.ts→advisor-mode.ts",
  "session-lifecycle.ts→computer-mode.ts", "rpc/prompt.ts→computer-mode.ts", "rpc/settings.ts→computer-mode.ts",
  // Computer-use provider pick (omp-desktop.json computer section: default =
  // OMP builtin / kimi = kimi-cu MCP). Same shape as browser-config: the file
  // lives under the profile agent dir via state.ts's H. The kimi branch of
  // setComputerMode drives the mid-session single-server mount/unmount in
  // mcp-mount (the only mid-session mutator of the tool surface), frames.ts
  // carries the provider/install projection, profile.ts re-warms on every
  // profile apply, and rpc/assets' test_kimi_cu RPC probes the builtin
  // connection. desktop-json.ts is the shared read/merge-write helper both
  // browser-config and computer-mode consume (extracted so the two sections
  // share one fault-tolerance + merge-write implementation).
  "desktop-json.ts→state.ts",
  "browser-config.ts→desktop-json.ts",
  "computer-mode.ts→desktop-json.ts", "computer-mode.ts→mcp-mount.ts", "computer-mode.ts→mcp-builtin.ts", "computer-mode.ts→stderr.ts",
  // Kimi auto-thinking gate (omp-desktop.json kimi section): the providers-page
  // switch writes it, the settings frame projects it, and the thinking-level
  // entry points (set_model/set_thinking/cycle_model/spawnSession) pin `auto`
  // to `high` on kimi-code while off. Pure-function module over desktop-json.
  "kimi-thinking.ts→desktop-json.ts",
  "frames.ts→kimi-thinking.ts", "rpc/settings.ts→kimi-thinking.ts",
  "rpc/models.ts→kimi-thinking.ts", "session-lifecycle.ts→kimi-thinking.ts",
  // LLM tool-approval gate (omp-desktop.json autoReview section): pure module
  // over desktop-json + bootstrap's model-role resolution; the select()
  // intercept lives in session-lifecycle, the switches in rpc/settings, and
  // the settings frame projects it.
  "auto-review.ts→desktop-json.ts", "auto-review.ts→bootstrap.ts",
  "session-lifecycle.ts→auto-review.ts", "rpc/settings.ts→auto-review.ts", "frames.ts→auto-review.ts",
  // Continuous title refresh (omp-desktop.json sessionTitles section): pure
  // module over desktop-json; agent_end hook in session-lifecycle, switch in
  // rpc/settings, settings-frame projection.
  // Per-branch titles add two edges: rpc/session journals the title on
  // rename_session and mirrors the branch's own title after navigate_tree
  // (branch switch is the only place the header must follow a branch), and
  // translate-history reads the customType to decide which record feeds the
  // rename phase row (title_change is header-global and ambiguous once a
  // session carries branch titles).
  "session-titles.ts→desktop-json.ts",
  "session-lifecycle.ts→session-titles.ts", "rpc/settings.ts→session-titles.ts", "frames.ts→session-titles.ts",
  "rpc/session.ts→session-titles.ts", "translate-history.ts→session-titles.ts",
  "frames.ts→computer-mode.ts", "rpc/assets.ts→computer-mode.ts", "profile.ts→computer-mode.ts",
  // A2: the seven private omp-desktop.json read/merge-write wheels converged
  // onto the shared desktop-json helpers — profile's project-list save (multi-
  // key overlay) + acp/sessionContext switches, assets' hooks/plugins switches
  // (mkdir stays caller-side), computerDisplay's remembered monitor, and
  // set_acp_config's inline merge. keepalive-config/ui-config swap their edges
  // in their own domain blocks below.
  "profile.ts→desktop-json.ts", "assets.ts→desktop-json.ts",
  "computer-display.ts→desktop-json.ts", "rpc/settings.ts→desktop-json.ts",
  // Computer-use display reconciliation: computer.display persists a Win32
  // monitor handle (xcap Monitor::id() = HMONITOR), which the kernel reassigns
  // every boot; computer-display.ts remembers the picked monitor by EDID name +
  // geometry in omp-desktop.json and re-points the setting. applyProfile runs it
  // on every profile apply (host boot included), the set_setting RPC on a pick,
  // and rpc/settings' list_displays reuses its enumeration.
  "computer-display.ts→settings-compat.ts", "computer-display.ts→state.ts", "computer-display.ts→stderr.ts",
  "profile.ts→computer-display.ts", "rpc/settings.ts→computer-display.ts",
  // Session lifecycle domain: main.ts mounts the create/load dispatches; the lifecycle depends on plan (restoring plan mode),
  // queue (queued-race fallback), profile (experiment switches), assets (plugin/hook switches)
  "main.ts→session-lifecycle.ts",
  "session-lifecycle.ts→state.ts", "session-lifecycle.ts→bootstrap.ts",
  "session-lifecycle.ts→goal.ts",
  "session-lifecycle.ts→session-context.ts", "session-lifecycle.ts→translate.ts",
  // 3a split: per-token delta coalescing lives in delta-coalesce.ts (40ms window,
  // same frame shape); UiEvent comes from the wire payload contract.
  "session-lifecycle.ts→delta-coalesce.ts", "delta-coalesce.ts→wire/payloads.ts",
  "session-lifecycle.ts→profile.ts", "session-lifecycle.ts→assets.ts",
  "session-lifecycle.ts→queue.ts", "session-lifecycle.ts→plan.ts",
  // A12 split: the session snapshot family (goal/todos/context/stats pushes +
  // the collapsed session_created frame body) lives in session-snapshot.ts;
  // the subagent roster (live registration/ownership tables + the three
  // eventBus subscriptions + the disk-replay function family) lives in
  // subagent-view.ts. session-lifecycle keeps the load/spawn orchestration and
  // re-exports pushContext/countCacheBreaks for the pre-split import surface.
  "session-lifecycle.ts→session-snapshot.ts", "session-lifecycle.ts→subagent-view.ts",
  "session-snapshot.ts→state.ts",
  // Stats bar's compaction counter: the session stats scan needs the same
  // journal markers the ACP persist layer defines (base `compaction` entry +
  // acpSummary block), so the constant is imported instead of re-spelled.
  "session-snapshot.ts→acp-persist.ts",
  "subagent-view.ts→state.ts", "subagent-view.ts→translate.ts",
  // Cache keepalive (an inline-extension domain conditionally injected behind an experiment switch;
  // three flat files keepalive/keepalive-config/keepalive-lib)
  "session-lifecycle.ts→keepalive.ts",
  "session-lifecycle.ts→keepalive-config.ts",
  "keepalive.ts→keepalive-config.ts", "keepalive.ts→keepalive-lib.ts",
  // Config source of truth = the keepalive section of omp-desktop.json (per-profile independent); reads/writes go through desktop-json.ts (A2)
  "keepalive-config.ts→desktop-json.ts",
  // PoolEntry carries the keepalive runtime snapshot type (type-only import,
  // same precedent as state.ts→goal.ts holding the controller instance)
  "state.ts→keepalive.ts",
  // A16: host-side keepalive state machine converged into keepalive-host.ts —
  // the keepaliveWanted flips (markTurnWrapped / markSeen), the zeroed
  // disabled-shape frame body (keepaliveStatusPayload) and the reportState
  // push (reportKeepaliveState). PoolEntry keeps the state fields; the four
  // former direct-write sites now call the operations one-way into the module.
  "keepalive-host.ts→state.ts", "keepalive-host.ts→keepalive.ts", "keepalive-host.ts→keepalive-config.ts",
  "session-lifecycle.ts→keepalive-host.ts",
  "rpc/session.ts→keepalive-host.ts", "rpc/prompt.ts→keepalive-host.ts",
  // UI config persistence (omp-desktop.json ui section: locale/theme/motion/prefs):
  // applyProfile re-reads the locale on every profile apply; the set_locale /
  // set_ui_prefs RPCs write it; frames.ts carries the readUiConfig projection;
  // read/write goes through desktop-json.ts (A2 convergence, same as keepalive-config)
  "profile.ts→ui-config.ts", "rpc/settings.ts→ui-config.ts", "ui-config.ts→desktop-json.ts",
  "frames.ts→ui-config.ts",
  // Desktop-owned browser routing (omp-desktop.json browser section: the
  // "use an external browser" switch). applyProfile re-applies it on every
  // profile apply; the set_external_browser RPC writes it; frames.ts carries
  // the readExternalBrowserEnabled projection. Same shape as ui-config: the
  // file lives under the profile agent dir (read/write through state.ts's H)
  // and the base keys are pinned via bootstrap.ts's lookupSetting.
  "profile.ts→browser-config.ts", "rpc/settings.ts→browser-config.ts",
  "browser-config.ts→state.ts", "browser-config.ts→bootstrap.ts",
  "frames.ts→browser-config.ts",
  // Queued message domain: followUp/steering views, park staging plus send-now/requeue/drop
  "main.ts→queue.ts", "queue.ts→bootstrap.ts", "queue.ts→state.ts",
  // Experiment switches (acp/sessionContext section) live in omp-desktop.json alongside the profile
  // Frame assembly layer: models/settings frames are shared by multiple rpc domains and main's ready frame
  // (why it is its own layer: settingsFrame combines the models snapshot with profile/assets switches; sinking into either side would create a cycle)
  "main.ts→frames.ts",
  "frames.ts→state.ts", "frames.ts→models.ts", "frames.ts→profile.ts", "frames.ts→assets.ts",
  "frames.ts→keepalive-config.ts", // The settings frame carries the omp-desktop.json keepalive section (feature-page configuration for experiments)
  // Nine RPC handler domains (third cut: the giant message switch became table-driven): main keeps only the dispatch shell
  "main.ts→rpc/index.ts",
  // Pooled-session file poll (external-write detection + fresh-session disk
  // materialization): the poll pushes session_list via handleListSessions so
  // the sidebar's pending row clears mid-run (same integration shape as
  // profile.ts's automations notify)
  "main.ts→session-poll.ts",
  "session-poll.ts→state.ts", "session-poll.ts→rpc/session.ts", "session-poll.ts→stderr.ts",
  "rpc/index.ts→rpc/types.ts",
  "rpc/index.ts→rpc/session.ts", "rpc/index.ts→rpc/prompt.ts", "rpc/index.ts→rpc/files.ts",
  "rpc/index.ts→rpc/models.ts", "rpc/index.ts→rpc/settings.ts", "rpc/index.ts→rpc/login.ts",
  "rpc/index.ts→rpc/assets.ts", "rpc/index.ts→rpc/terminal.ts", "rpc/index.ts→rpc/limits.ts",
  "rpc/index.ts→rpc/browser.ts",
  "rpc/index.ts→rpc/bash-complete.ts",
  // Agent browser live mirror (right-panel live view of the built-in browser):
  // main starts the registry poll and tracks the UI ws lifecycle; the rpc
  // domain only forwards the three mirror commands (one-way downward)
  "main.ts→browser-mirror.ts",
  "rpc/browser.ts→rpc/types.ts", "rpc/browser.ts→browser-mirror.ts",
  "browser-mirror.ts→state.ts", // frame stamps (stampEvent) share the push infra
  "rpc/session.ts→rpc/types.ts",
  "rpc/session.ts→bootstrap.ts", "rpc/session.ts→state.ts", "rpc/session.ts→profile.ts",
  "rpc/session.ts→translate.ts", "rpc/session.ts→session-lifecycle.ts",
  // get_keepalive_status reads the global switch alongside the entry snapshot
  // (same precedent as rpc/settings.ts→keepalive-config.ts)
  "rpc/session.ts→keepalive-config.ts",
  // Session activity time (list/branch rows): the SDK reports `modified` as the
  // file mtime, which a `session_exit` diagnostic frame refreshes, so
  // rpc/session.ts rewrites it to the last `message` frame's timestamp
  "rpc/session.ts→activity-time.ts",
  "rpc/prompt.ts→rpc/types.ts", "rpc/prompt.ts→rpc/session.ts",
  "rpc/prompt.ts→bootstrap.ts", "rpc/prompt.ts→state.ts", "rpc/prompt.ts→translate.ts",
  // ! bash-mode completion: PATH scan + cwd path candidates (reads the pool for the session cwd, replies on its ws)
  "rpc/bash-complete.ts→rpc/types.ts", "rpc/bash-complete.ts→state.ts",
  "rpc/prompt.ts→session-lifecycle.ts", "rpc/prompt.ts→plan.ts", "rpc/prompt.ts→queue.ts",
  "rpc/files.ts→rpc/types.ts", "rpc/files.ts→state.ts", "rpc/files.ts→session-lifecycle.ts",
  // Remote-workspace file RPCs: path translation via the stub marker + ssh exec/error helpers from the ssh domain
  "rpc/files.ts→bootstrap.ts", "rpc/files.ts→remote-workspaces.ts", "rpc/files.ts→rpc/ssh.ts",
  "rpc/models.ts→rpc/types.ts", "rpc/models.ts→bootstrap.ts", "rpc/models.ts→state.ts",
  "rpc/models.ts→models.ts", "rpc/models.ts→frames.ts", "rpc/models.ts→limits",
  "rpc/models.ts→stats.ts",
  "rpc/settings.ts→rpc/types.ts", "rpc/settings.ts→rpc/session.ts",
  "rpc/settings.ts→state.ts", "rpc/settings.ts→models.ts", "rpc/settings.ts→frames.ts",
  "rpc/settings.ts→profile.ts", "rpc/settings.ts→assets.ts", "rpc/settings.ts→plan.ts",
  "rpc/settings.ts→keepalive-config.ts", // set_keepalive_config merges into the omp-desktop.json keepalive section
  "rpc/login.ts→rpc/types.ts", "rpc/login.ts→bootstrap.ts", "rpc/login.ts→state.ts",
  "rpc/login.ts→models.ts", "rpc/login.ts→frames.ts",
  "rpc/login.ts→open-external.ts", "rpc/settings.ts→open-external.ts", // cross-platform browser/folder launch (rundll32 / open / xdg-open)
  "rpc/settings.ts→editors.ts", // right-panel file menu: app discovery (.app probe + .icns icon) and CLI-first launch
  "rpc/login.ts→account-order.ts", // provider_reorder_account: active credential id permutation
  "rpc/index.ts→rpc/provider-wizard.ts",
  "rpc/provider-wizard.ts→rpc/types.ts", "rpc/provider-wizard.ts→state.ts",
  "rpc/provider-wizard.ts→rpc/login.ts", // shared catalog convergence push (refreshCatalogAndPush)
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
  // SSH remote workspaces (welcome-flow remote connection): host CRUD + workspace
  // stubs over the base's ssh.json / capability caches (bootstrap handles), stub
  // marker owned by remote-workspaces.ts; list_sessions decorates project rows
  // with the remote label (no system-prompt injection — the base owns the prompt)
  "rpc/index.ts→rpc/ssh.ts",
  "rpc/ssh.ts→rpc/types.ts", "rpc/ssh.ts→bootstrap.ts", "rpc/ssh.ts→remote-workspaces.ts",
  "remote-workspaces.ts→bootstrap.ts",
  "rpc/session.ts→remote-workspaces.ts",
  // Probe failures are diagnostics: the untruncated ssh stderr goes to the host
  // log via safeStderr (same one-way edge as the other RPC domains)
  "rpc/ssh.ts→stderr.ts",
  // Voice conversation (speech synthesis + dictation): voice.ts bridges the
  // session-event stream to the vocalizer and owns the STT controller
  // (SDK handles via bootstrap, settings via settings-compat, frames stamped
  // via state). session-lifecycle feeds it events; profile re-wires it on
  // switch; the rpc domain forwards the two push-to-talk commands.
  "voice.ts→bootstrap.ts", "voice.ts→state.ts", "voice.ts→settings-compat.ts",
  "voice.ts→stderr.ts", // cache-probe failure diagnostics go through safeStderr (A5)
  "session-lifecycle.ts→voice.ts", "profile.ts→voice.ts",
  "rpc/index.ts→rpc/voice.ts", "rpc/voice.ts→rpc/types.ts", "rpc/voice.ts→voice.ts",
  "rpc/settings.ts→voice.ts",
  "rpc/voice.ts→state.ts", "rpc/voice.ts→settings-compat.ts",
  // Automations (scheduled tasks): profile.ts arms the scheduler (boot-time
  // applyProfile = profileReady, plus hot-switch re-arm) and bridges the
  // session_list notify; the domain reads H via state and reuses spawnSession
  // for dispatch; rpc/automations.ts is the CRUD/toggle/run_now/preview front
  // over cron+store+scheduler.
  "profile.ts→rpc/session.ts", // automations notify pushes session_list via handleListSessions
  "profile.ts→automations/scheduler.ts",
  "automations/cron.ts→automations/types.ts",
  "automations/store.ts→automations/types.ts", "automations/store.ts→state.ts",
  "automations/scheduler.ts→automations/cron.ts", "automations/scheduler.ts→automations/store.ts",
  "automations/scheduler.ts→automations/types.ts", "automations/scheduler.ts→state.ts",
  "automations/scheduler.ts→session-lifecycle.ts", "automations/scheduler.ts→stderr.ts",
  // Dispatch reads the automation settings page's dialog deadlines (omp-desktop.json
  // automations.askTimeoutSec / approvalTimeoutSec) per run.
  "automations/scheduler.ts→profile.ts",
  "rpc/index.ts→rpc/automations.ts",
  "rpc/automations.ts→rpc/types.ts",
  "rpc/automations.ts→automations/types.ts", "rpc/automations.ts→automations/cron.ts",
  "rpc/automations.ts→automations/store.ts", "rpc/automations.ts→automations/scheduler.ts",
  // Agent-facing create_automation tool: automations/create.ts is the single
  // create entry (validation + id minting + born-completed rule) now shared by
  // the UI RPC and the tool, so both front doors enforce the same contract.
  "rpc/automations.ts→automations/create.ts",
  "automations/create.ts→automations/cron.ts", "automations/create.ts→automations/store.ts",
  "automations/create.ts→automations/types.ts", "automations/create.ts→i18n/host.ts",
  // The tool injects through session-lifecycle's customTools (same slot as
  // read_session_context) and pushes automations_list to the attached UI.
  "session-lifecycle.ts→automations-tool.ts",
  "automations-tool.ts→automations/create.ts", "automations-tool.ts→automations/store.ts",
  "automations-tool.ts→automations/types.ts", "automations-tool.ts→state.ts",
  // session_list backfills the automation badge from the persisted runs ledger
  // (pool eviction/restart must not drop it); read-only store access
  // delete/archive also retire the automations that deliver into the session
  // (automations/store.ts retireAutomationsForPaths)
  "rpc/session.ts→automations/store.ts",
  // Delivery framing has two ends in one place: the scheduler writes the header, the
  // transcript strips it back into the bubble marker (types.ts only carries the constant)
  "translate.ts→automations/delivery.ts",
  "automations/scheduler.ts→automations/delivery.ts",
  "automations/delivery.ts→automations/types.ts",
  // type-only: buildSessionListPayload's return is checked against the wire frame
  "rpc/session.ts→wire/frames-session.ts",
  // /btw side conversations: btw.ts owns the topic lifecycle over the SDK primitives;
  // rpc/btw.ts narrows the wire and promotes topics into pooled sessions
  "btw.ts→bootstrap.ts", "btw.ts→state.ts", "btw.ts→stderr.ts",
  "rpc/btw.ts→btw.ts", "rpc/btw.ts→bootstrap.ts", "rpc/btw.ts→state.ts",
  "rpc/btw.ts→session-lifecycle.ts", "rpc/btw.ts→stderr.ts", "rpc/btw.ts→rpc/types.ts",
  "rpc/index.ts→rpc/btw.ts",
  // rpc/collab.ts: relay collab rooms over pooled sessions (statusLine seam fans live frames)
  "rpc/collab.ts→state.ts", "rpc/collab.ts→i18n/host.ts", "rpc/collab.ts→stderr.ts",
  "rpc/collab.ts→wire/frames-live.ts", "rpc/collab.ts→rpc/types.ts",
  "rpc/index.ts→rpc/collab.ts", "rpc/prompt.ts→rpc/collab.ts", "rpc/session.ts→rpc/collab.ts",
  // rpc/worktree.ts: git worktree session create/status/remove over Bun.spawn
  "rpc/worktree.ts→rpc/types.ts", "rpc/index.ts→rpc/worktree.ts",
  // rpc/git-graph.ts: read-only commit graph + commit detail for the middle-column
  // Git page (log/show/rev-list over Bun.spawn; localized failure copy)
  "rpc/git-graph.ts→rpc/types.ts", "rpc/git-graph.ts→i18n/host.ts",
  "rpc/index.ts→rpc/git-graph.ts",
  // rpc/git-compare.ts: the two-version file reads behind the Git page's compare
  // view (commit/index/worktree pairs); same leaf shape as git-graph.
  "rpc/git-compare.ts→rpc/types.ts", "rpc/git-compare.ts→i18n/host.ts",
  "rpc/index.ts→rpc/git-compare.ts",
  // git.ts is the single host-side git process layer (argv shape, env, timeout,
  // read/write lock class) — modelled on IntelliJ's gitImplBase. Every module
  // that shells out to git must route through it, so no call site can forget
  // GIT_OPTIONAL_LOCKS=0 / GIT_TERMINAL_PROMPT=0 / a hard timeout. It is a leaf:
  // it imports nothing from the host but node builtins, so no edge points back.
  "rpc/files.ts→git.ts", "rpc/git-graph.ts→git.ts", "rpc/git-compare.ts→git.ts", "rpc/worktree.ts→git.ts",
  "session-lifecycle.ts→git.ts",
  // /btw slash input dispatches a side question straight from the composer
  "rpc/prompt.ts→btw.ts",
  // Host i18n (A8): the host-owned i18next instance lives in host/i18n/ (moved
  // out of ui-src/ to cut the host→ui-src reverse dependency); every module
  // that emits user-visible host copy imports the shared instance. Locale
  // data files under i18n/locales/ are consumed via default imports, which
  // the named-import scanner below does not see — they stay internal to
  // i18n/host.ts only.
  "assets.ts→i18n/host.ts", "bootstrap.ts→i18n/host.ts", "btw.ts→i18n/host.ts", "computer-display.ts→i18n/host.ts",
  "computer-mode.ts→i18n/host.ts",
  "editors.ts→i18n/host.ts", "extensions.ts→i18n/host.ts", "goal.ts→i18n/host.ts",
  "main.ts→i18n/host.ts", "mcp-builtin.ts→i18n/host.ts", "mcp-mount.ts→i18n/host.ts", "mcp-pool.ts→i18n/host.ts",
  "plan-approve.ts→i18n/host.ts",
  "plan.ts→i18n/host.ts", "profile.ts→i18n/host.ts", "pty.ts→i18n/host.ts",
  "queue.ts→i18n/host.ts", "session-lifecycle.ts→i18n/host.ts", "session-poll.ts→i18n/host.ts", "state.ts→i18n/host.ts",
  // LAN remote control (spec §3, ADR-0008): remote.ts owns the second Bun.serve
  // (fixed port, 0.0.0.0, static dist + token upgrade) and the omp-desktop.json
  // remote section; ws-shared.ts holds the open/message/close handlers BOTH
  // servers share (extracted verbatim from main.ts — takeover kick, ready
  // handshake, dispatchRpc) so the protocol never forks by origin. The handler
  // set is injected into remote.ts (setRemoteWsHandlers) instead of imported,
  // keeping remote.ts free of a remote->rpc->remote cycle; dispatchRpc imports
  // REMOTE_WRITE_DENYLIST back for the remote read-only gate (spec §3.5).
  "main.ts→ws-shared.ts", "main.ts→remote.ts",
  "ws-shared.ts→state.ts", "ws-shared.ts→i18n/host.ts", "ws-shared.ts→models.ts", "ws-shared.ts→frames.ts",
  "ws-shared.ts→rpc/index.ts", "ws-shared.ts→settings-compat.ts", "ws-shared.ts→browser-mirror.ts", "ws-shared.ts→stderr.ts",
  "ws-shared.ts→remote.ts", // open handler records the visiting device (settings page device-history card)
  "remote.ts→desktop-json.ts", "remote.ts→stderr.ts",
  "frames.ts→remote.ts", // settings frame carries the remote-section projection (settings page's remote group)
  "rpc/index.ts→remote.ts", "rpc/index.ts→rpc/remote.ts",
  "rpc/remote.ts→remote.ts", "rpc/remote.ts→rpc/types.ts", "rpc/remote.ts→frames.ts", "rpc/remote.ts→state.ts",
  // Wire contract neutral ground (A10): pure-type single source shared with the
  // UI (ui-src/types/frames.ts re-exports it; that direction is outside this
  // table). Host consumers re-export the payload shapes from state/translate;
  // wire itself stays a leaf except for the type-only Automation borrow.
  "state.ts→wire/payloads.ts", "translate.ts→wire/payloads.ts",
  "wire/frames-live.ts→automations/types.ts", // type-only: Automation/AutomationRun shapes
  "wire/frames-session.ts→wire/payloads.ts", "wire/frames-models.ts→wire/payloads.ts",
  "wire/frames-live.ts→wire/payloads.ts", "wire/frames-live.ts→wire/frames-models.ts",
  "wire/index.ts→wire/payloads.ts", "wire/index.ts→wire/frames-session.ts",
  "wire/index.ts→wire/frames-models.ts", "wire/index.ts→wire/frames-live.ts",
  "translate.ts→i18n/host.ts", "ui-config.ts→i18n/host.ts",
  "rpc/assets.ts→i18n/host.ts", "rpc/automations.ts→i18n/host.ts", "rpc/btw.ts→i18n/host.ts",
  "rpc/capabilities.ts→i18n/host.ts", "rpc/files.ts→i18n/host.ts", "rpc/index.ts→i18n/host.ts",
  "rpc/limits.ts→i18n/host.ts", "rpc/login.ts→i18n/host.ts", "rpc/models.ts→i18n/host.ts",
  "rpc/provider-wizard.ts→i18n/host.ts", "rpc/prompt.ts→i18n/host.ts", "rpc/session.ts→i18n/host.ts",
  "rpc/settings.ts→i18n/host.ts", "rpc/ssh.ts→i18n/host.ts",
  // Line-cap splits (2026-10 audit, all three hot files over the ratchet):
  // translate.ts sheds the tool-row projection (pure functions over TranscriptItem,
  // RULE-001 contract face) to translate-tool.ts and the /tree display projection to
  // entry-tree.ts (same domain name as the front-end store slice); both are leaves
  // re-exported nowhere — callers import the new homes directly.
  "translate.ts→translate-tool.ts", "translate-tool.ts→state.ts",
  // Advisor advice batches (customType "advisor") get their own projection module:
  // live event + reload row + the details{notes} normalizer, so translate.ts keeps its
  // line ratchet. Same leaf contract as translate-tool.ts.
  "translate.ts→translate-advisor.ts", "translate-advisor.ts→state.ts",
  "translate-advisor.ts→wire/payloads.ts",
  // translate.ts hit its line cap, so disk replay (entriesToTranscript +
  // sumRunDurationMs) moved to translate-history.ts. It is a leaf like translate-tool.ts:
  // callers import it directly, and it borrows only the four small text helpers from
  // translate.ts — the reverse edge stays empty.
  "translate-history.ts→translate.ts", "translate-history.ts→translate-tool.ts",
  "translate-history.ts→wire/payloads.ts", "translate-history.ts→i18n/host.ts",
  "translate-history.ts→automations/delivery.ts", "translate-history.ts→translate-advisor.ts",
  "session-lifecycle.ts→translate-history.ts", "rpc/prompt.ts→translate-history.ts",
  "rpc/session.ts→translate-history.ts",
  "entry-tree.ts→translate.ts", "entry-tree.ts→i18n/host.ts",
  "rpc/session.ts→entry-tree.ts",
  // session-lifecycle.ts sheds the per-socket wiring closure (event fan-out, approval
  // uiCtx, extension runner init, unsubscribe teardown) to session-entry-core.ts; the
  // create/load entry points stay and re-export attachEntry for the frozen rpc callers.
  "session-lifecycle.ts→session-entry-core.ts",
  // detachEntryUi (the per-socket fan-out teardown) is shared by the socket close
  // handler and the frontend's mcp_detach (LRU eviction signal), so both paths drop
  // the watcher identically — the idle sweep only reclaims entries with no watcher.
  "ws-shared.ts→session-entry-core.ts", "rpc/assets.ts→session-entry-core.ts",
  "session-entry-core.ts→state.ts", "session-entry-core.ts→bootstrap.ts",
  "session-entry-core.ts→translate.ts", "session-entry-core.ts→delta-coalesce.ts",
  "session-entry-core.ts→session-snapshot.ts", "session-entry-core.ts→subagent-view.ts",
  "session-entry-core.ts→queue.ts", "session-entry-core.ts→plan-approve.ts",
  "session-entry-core.ts→auto-review.ts", "session-entry-core.ts→keepalive-host.ts",
  "session-entry-core.ts→capabilities.ts", "session-entry-core.ts→voice.ts",
  "session-entry-core.ts→async-jobs.ts", "session-entry-core.ts→session-titles.ts",
  "session-entry-core.ts→i18n/host.ts", "session-entry-core.ts→stderr.ts",
  // The approval uiCtx resolves this session's permission-approval deadline
  // (ask.timeout, or the automation run's own value) off entry.session.settings.
  "session-entry-core.ts→settings-compat.ts",
  // Dialog deadline policy split out of the entry-core wiring: settings read +
  // the ask-dialog auto-answer shape, used only by the approval uiCtx.
  "session-entry-core.ts→dialog-deadline.ts",
  "dialog-deadline.ts→state.ts", "dialog-deadline.ts→settings-compat.ts",
  // assets.ts sheds the path-resolution leaf (asset-paths.ts, shared by both domains),
  // the MCP domain (mcp-assets.ts) and the plugins/hooks domain (plugin-assets.ts);
  // assets.ts keeps skill scanning + the listAgentAssets aggregation entry.
  "assets.ts→asset-paths.ts", "assets.ts→mcp-assets.ts", "assets.ts→plugin-assets.ts",
  "asset-paths.ts→i18n/host.ts", "asset-paths.ts→state.ts", "asset-paths.ts→bootstrap.ts",
  "asset-paths.ts→settings-compat.ts",
  "mcp-assets.ts→i18n/host.ts", "mcp-assets.ts→state.ts", "mcp-assets.ts→bootstrap.ts",
  "mcp-assets.ts→profile.ts", "mcp-assets.ts→stderr.ts", "mcp-assets.ts→asset-paths.ts",
  "plugin-assets.ts→state.ts", "plugin-assets.ts→bootstrap.ts",
  "plugin-assets.ts→desktop-json.ts", "plugin-assets.ts→asset-paths.ts",
  "frames.ts→plugin-assets.ts", "session-lifecycle.ts→plugin-assets.ts",
  "mcp-builtin.ts→mcp-assets.ts", "mcp-mount.ts→mcp-assets.ts",
  "rpc/assets.ts→asset-paths.ts", "rpc/assets.ts→mcp-assets.ts", "rpc/assets.ts→plugin-assets.ts",
  "rpc/prompt.ts→plugin-assets.ts", "rpc/settings.ts→plugin-assets.ts",
]);

// Scan one level of host/ plus the rpc/, automations/, i18n/ and wire/ subtrees (keys carry a path prefix like rpc/session.ts)
const files = [
  ...readdirSync(hostDir).filter((f) => f.endsWith(".ts")),
  ...readdirSync(join(hostDir, "rpc")).filter((f) => f.endsWith(".ts")).map((f) => `rpc/${f}`),
  ...readdirSync(join(hostDir, "automations")).filter((f) => f.endsWith(".ts")).map((f) => `automations/${f}`),
  ...readdirSync(join(hostDir, "i18n")).filter((f) => f.endsWith(".ts")).map((f) => `i18n/${f}`),
  ...readdirSync(join(hostDir, "wire")).filter((f) => f.endsWith(".ts")).map((f) => `wire/${f}`),
  ...readdirSync(join(hostDir, "i18n", "locales")).filter((f) => f.endsWith(".ts")).map((f) => `i18n/locales/${f}`),
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
  for (const m of src.matchAll(/export\s+(?:type\s*)?\{([^}]+)\}/g)) {
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
    // Out-of-tree relative imports (the former ../ui-src/i18n/host.ts ->
    // "ui-src/i18n/host.ts" bridge) used to be skipped here; since the host
    // i18n instance moved into host/i18n/ (A8) the host has zero ui-src/
    // edges, so anything not resolving to a scanned host/ location
    // (top level, rpc/, automations/, i18n/, wire/) is a violation, not a skip.
    const scannedPrefix = imp.target.startsWith("rpc/") || imp.target.startsWith("automations/") || imp.target.startsWith("i18n/") || imp.target.startsWith("wire/");
    if (imp.target.includes("/") && !scannedPrefix) {
      problems.push(`非法依赖边: ${file}→${imp.target}（host 出树导入禁止，目标不属于 host 扫描域）`);
      continue;
    }
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
