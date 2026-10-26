# omp desktop

[English](README.md) | [简体中文](README.zh-CN.md)

omp desktop is a cross-platform desktop client for omp (oh-my-pi), an AI coding agent. It puts the agent in a native window: chat with models, watch it edit files and run commands, and inspect context, diffs, subagents, terminal, and browser along the way. The agent runtime ships inside the app — no separate omp CLI install needed.

Built on **Tauri 2** (Rust shell, Bun host, React 19 + Vite + Tailwind v4 UI).

## One process, not one per session

Every other desktop client for a CLI-style agent spawns a separate runtime process per session and talks to it over RPC. The omp runtime carries roughly 210MB of base overhead per copy, so nine open sessions approach 3GB — and each one is a separate failure domain that dies on its own.

omp desktop embeds the omp SDK as a library. One Bun host process holds every session in a pool and shares a single auth/model/settings base across them. Two sessions in one process measure 385MB.

Embedding the SDK rather than shelling out to a protocol is what makes the rest of this app possible:

- **Runtime injection.** Custom tools are registered as live functions through `createAgentSession({ customTools })`, and system prompts are extended per session. A tool that only exists as a serialized RPC payload cannot do this.
- **Shared, hot state.** One process holds the model catalog, MCP connections, terminal PTYs, and browser mirrors for every open session — switch sessions and they are already warm.
- **Single failure domain.** Trade-off, stated plainly: a host crash takes all sessions with it. Session state is JSONL on disk and survives restart.

Sessions persist per working directory as JSONL and reload after restart.

## Context forensics

Most clients show a token count. omp desktop shows where every token went.

Hover the context ring for a live breakdown — system tools, MCP tools split by tools / prompt / device, system prompt, memory, skills, repo rules, and messages broken into compressed vs. active zones — plus **provider quota tiers with reset countdowns and balance** across 21 vendors, and cache-warming savings (probes, next probe countdown, spend, tokens saved).

A permanent stats bar under the composer runs at 4 Hz while streaming: cache hit rate and cache breaks, cache read/write, in/out tokens, token speed, cost (including subagent cost with double-count correction), active time, TTFT, and compression count.

## Features

### Sessions and conversation

- Multiple concurrent sessions with a sidebar, project groups, pinning, archive, and inline rename
- **Session entry tree** — the full transcript as a navigable waterfall with per-card drawers, jump navigation, content filters, and fork branch switching
- Message queue: stack follow-ups while the agent works, reorder them, or steer mid-turn
- Streaming markdown with shiki highlighting, CJK-aware line breaking, Mermaid **and** Graphviz DOT/SVG rendering, tables, task lists, and image paths that open in the preview panel
- **Four-level noise folding**: long tool runs collapse into "explored 29 files, ran 14 commands" instead of 400 rows
- In-house diff renderer (no third-party diff dependency) with a 4000-line cap and single-pass syntax state across line boundaries
- **Git manager** in the middle column (a project row's more menu): commit graph across every local/remote ref with lane topology, a branch tree that scopes the history, and the selected commit's full message, per-file numstat totals, and parent links
- Composer built on Lexical: screenshot paste, file drag-drop, `!` bash mode with PATH completion, `@` / slash / `$` sigil completion, ghost-text inline completion, history recall, and push-to-talk dictation
- Image lightbox with zoom and pan

### Agents and delegation

- **Agent Hub** in the middle column: subagent roster in flat or by-parent tree mode, aggregate usage, inline steer and stop, Enter to open the subagent's own tab
- Per-subagent inspector: task, current activity, context gauge, lineage, changed files, output, and a live activity feed
- Agent definitions editable in-app (create, read, save subagent markdown)
- Three permission modes (always-ask / write / yolo) plus per-role model assignment

### Tooling surfaces (right panel)

Eight resizable, drag-reorderable tabs, each with independent state per session:

| Tab | What it does |
|---|---|
| **Terminal** | Real host PTY (Windows ConPTY / POSIX), one per session; detached terminals keep running |
| **Browser** | Manual sandboxed browser plus a **live CDP screencast mirror** of the agent's own browser — watch it drive pages, or take over and drive them yourself |
| **Git diff** | Tree or flat file view, per-file stage / unstage / discard, commit with message, push, and the in-house diff detail view |
| **Files** | Lazy project tree, image preview, line-range highlighting, and open-in-editor / terminal / file-manager |
| **Subagent** | Card list plus the Hub inspector for each delegate |
| **Agent Hub** | Same inspector, opened from the hub card |
| **Background commands** | Running bash / shell / eval plus host job snapshots; expandable, survives streaming repaints |
| **Side Chat (`/btw`)** | Parallel side-conversations on the same session and model without disturbing the main thread |

### Scheduling and automation

- **Scheduled automations**: structured rules (minute / hourly / daily / weekly / monthly) or raw 5-field cron, each firing a fresh session bound to a cwd and model; enable/disable, run-now, next-3-runs preview, and per-task run history
- The agent can create its own automations via a `create_automation` tool
- Scheduler advances and persists the next-run slot **before** dispatch, so a host crash can never double-fire a slot

### Extended capabilities

- **SSH remote workspaces**: mount remote directories as local stub workspaces via `ssh.json` host aliases, with connectivity probes and remote directory browsing
- **LAN remote control**: serve the UI on `0.0.0.0:<port>` behind a 128-bit access key; remote clients can observe everything and are denied every write RPC
- **Computer use**: per-session toggle with two providers, physical-display selection, and external browser routing
- **Voice**: push-to-talk dictation with local STT model download, and speech output through system voices
- **Local statistics dashboard**: 11 sections covering usage, models, providers, costs, requests, errors, trace timelines, tool performance, frustration analysis, and projects
- `/goal` mode — token-budgeted goal with pause / resume / drop and auto-stop when a continuation makes no new tool progress

### Configuration

A 28-page settings center with search that jumps to and highlights any key. Real CRUD, not JSON editing:

- **Models and providers** — OAuth sign-in or API key + base URL, per-model enable and connectivity test, model metadata editor, multi-account disable/reorder, plan quota lookup, custom OpenAI-compatible provider wizard, model roles, and a quick-switch cycle
- **MCP servers** — add / edit / delete with transport, sharing scope, env and headers, per-server test, log viewer, and test-all
- **Skills, hooks, agents, plugins, extensions, memory** — per-scope discovery and enable/disable, content editing, marketplace auto-update, and a memory file browser across four backends
- **Shell** — graphical ordered first-match bash approval rules and interceptor rules, not raw pattern lists
- **Developer** — auto-QA, GC tuning, low-level compaction knobs
- **Advanced** — every remaining base setting, grouped by prefix
- Proxy / no-proxy / custom CA certificates, terminal font picker, per-profile isolation

### Interface

- Six themes (dark, light, midnight, warm-paper, deep-think, coral) or follow-system, UI font and size, and a motion on/off switch
- Message rail whose tick widths react to system audio spectrum
- Desktop notifications with sound, system tray (closing the window hides it on Windows and macOS), and a single-instance lock
- Automatic in-app updates with progress and relaunch
- UI in English, 简体中文, and 繁體中文
- Global search palette (⌘⇧F) across settings items and sessions

## Install

Download a build from [Releases](https://github.com/a1398394385/oh-my-pi-desktop/releases/latest).

**macOS (Apple Silicon)** — open the `.dmg` and drag the app to Applications. Builds are ad-hoc signed, so the first launch needs one of:

- Right-click the app → Open → Open, or
- `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`

**Windows (x64)** — run the `-setup.exe` (NSIS installer) or the `.msi`.

Updates are delivered in-app; you can also trigger a check manually under Settings → General → Check for Updates.

## Getting started

1. Launch the app and open Settings → Model to add a provider — the wizard walks you through OAuth sign-in or an API key with a base URL.
2. Create a session, pick a project directory and a model, and start chatting.
3. The agent reads and edits files, runs commands, and reports back in the conversation. Use the right panel to see what it did, and hover the context ring to see what it spent.

## Project status

**v0.3.0** (2026-10-23). Tracks omp **18.12.5**, the current upstream release.

- **macOS** (Apple Silicon) and **Windows** (x64) — unsigned builds, see Install
- Linux packaging not yet produced
- In-app plugin installation not yet available; use `omp plugin install <package>`

Version tracking is a deliberate design decision: the desktop pins the published omp SDK version rather than vendoring a fork, so upstream features and fixes arrive here without a rebase. The only patches carried are two small behavior additions the SDK does not yet expose — an advisor compaction override, and pool-ordered credential selection (the desktop reorders accounts, and the SDK had no reorder API).

## Documentation

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — architecture, running from source, releasing
- [AGENTS.md](AGENTS.md) — repo conventions for contributors and agents
- [docs/PITFALLS.md](docs/PITFALLS.md) — external-dependency pitfalls (omp SDK / Tauri / macOS)

## License

MIT — same terms as the [omp](https://github.com/can1357/oh-my-pi) SDK it embeds.
