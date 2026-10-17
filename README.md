# omp desktop

[English](README.md) | [简体中文](README.zh-CN.md)

omp desktop is a cross-platform desktop client for omp (oh-my-pi), an AI coding agent. It puts the agent in a native window: chat with models, watch it edit files and run commands, and inspect context, diffs, and subagents along the way. The agent runtime ships inside the app — no separate omp CLI install needed.

## Why a single process

Desktop shells for CLI agents usually spawn one child process per session. Each copy of the omp runtime carries roughly 210MB of base overhead, so nine open sessions approach 3GB.

omp desktop embeds the omp SDK as a library instead: one Bun host process holds every session in a pool and shares one auth/model/settings base across them. Two sessions in a single process measured 385MB total.

Sessions persist to disk as JSONL per working directory and survive restarts.

## Features

- Multiple concurrent sessions with a sidebar, plus a per-session entry tree
- Streaming markdown rendering with syntax highlighting, CJK-aware line breaking, and mermaid diagrams
- Multi-provider model access: sign in with OAuth (credentials auto-renewed) or configure an API key and base URL; in-app plan quota lookup covers 21 providers
- Model roles (different models per role) and thinking budgets from Minimal to Max, including auto
- Message queue — stack follow-up prompts while the agent works, and steer it mid-turn
- Git integration: branch switching and diff review
- Detail panel: context usage breakdown, file viewer, subagent inspector, terminal, and browser mirror
- Paste screenshots or drag files straight into the composer
- macOS notifications, system tray (closing the window hides it), and a single-instance lock
- Automatic in-app updates (Settings → General → App → Check for Updates)
- Six themes (dark, light, midnight, warm-paper, deep-think, coral) with an option to follow the system
- UI in English and 简体中文
- Automatic context compaction (ACP) and session keepalive for long-running work
- Manage MCP servers, skills, memories, plugins, and hooks from Settings

## Install

Download a build from [Releases](https://github.com/a1398394385/oh-my-pi-desktop/releases/latest).

**macOS (Apple Silicon)** — open the `.dmg` and drag the app to Applications. Builds are ad-hoc signed, so the first launch needs one of:

- Right-click the app → Open → Open, or
- `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`

**Windows (x64)** — run the `-setup.exe` (NSIS installer) or the `.msi`.

Updates are delivered in-app; you can also trigger a check manually under Settings → General → App → Check for Updates.

## Getting started

1. Launch the app and open Settings → Models to add a provider — the wizard walks you through OAuth sign-in or an API key with a base URL.
2. Create a session, pick a project directory and a model, and start chatting.
3. The agent reads and edits files, runs commands, and reports back in the conversation; use the detail panel to inspect what it did.

## Documentation

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — architecture, running from source, releasing
- [AGENTS.md](AGENTS.md) — repo conventions for contributors and agents
- [docs/PITFALLS.md](docs/PITFALLS.md) — external-dependency pitfalls (omp SDK / Tauri / macOS)

## License

All rights reserved.
