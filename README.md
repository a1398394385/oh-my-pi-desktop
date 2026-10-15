# omp desktop

[English](README.md) | [简体中文](README.zh-CN.md)

Desktop shell for omp (oh-my-pi). **Embedded-library architecture**: a single Bun host process embeds the `@oh-my-pi/pi-coding-agent` SDK and holds all sessions (an etower-agent-style session pool), instead of one `omp --mode rpc` child process per session — the latter costs ~210MB of base overhead per session (9 sessions ≈ 3GB); this approach measured 385MB total for 2 sessions in a single process.

## Architecture

```
┌─ Tauri shell (src-tauri) ───────┐        ┌─ Bun host (host/) ────────────────┐
│ Window + WKWebView loads        │        │ omp SDK embedded as a library     │
│   ui/dist                       │        │ One process-wide base             │
│ Spawns the host, forwards the   │ ────▶  │   (auth / model / settings)       │
│   dynamic WS port               │        │ Map<sessionId, PoolEntry>         │
│ Kills host on exit; watchdog    │        │ Sessions persisted under          │
│   restarts at a limited rate    │        │   ~/.omp/agent/sessions/          │
└─────────────────────────────────┘        └───────────────────────────────────┘
        ▲ WebSocket (dynamic port)
        └─────── ui/dist static build connects directly ──────────┘
```

- A session is one `createAgentSession()` instance inside the host process; tools execute directly in the host, no host-tool bridge. Transcripts persist per-cwd (JSONL) and survive restarts
- Frontend in `ui-src/` (React 19 + TypeScript + Vite + Tailwind v4 + zustand + streamdown + Lexical), build output in `ui/dist/`
- `host/limits/`: provider plan quota lookup (21 providers, 34 omp provider ids); credentials are resolved via authStorage first (OAuth auto-renewal)
- Profile isolation via `OMP_PROFILE`, default `default`; tests are forced onto `omp-desktop-test`

## Running

```bash
bun install
bun run ui:build            # build the frontend first (no HMR in the desktop app; tauri dev loads the prebuilt bundle)
OMP_DESKTOP_MODEL=deepseek/deepseek-flash bunx tauri dev   # the default model is a slow local one; overriding is recommended
```

The host can be verified standalone (without Tauri):

```bash
bun scripts/smoke.ts               # full-chain smoke against a real model (create session → prompt → persist → load & resume)
bun scripts/probe-sdk.ts           # assembly probe only
bun scripts/probe-asset-sources.ts # how source toggles constrain the asset list
```

Full-repo checks: `bun run check` (encoding gate / host boundary / architecture ratchet / style token gate / version consistency / typecheck). See `scripts/` for the smoke script list.

## Releasing

```bash
bun run version:set 0.2.0        # version SSOT lives in src-tauri/tauri.conf.json, mirrored to Cargo.toml automatically
git commit -am "release: 0.2.0"
git tag v0.2.0 && git push origin main --tags
```

The tag triggers `.github/workflows/release.yml`: it validates the tag against the version → builds per platform → publishes a draft Release (with updater artifacts and `latest.json`). **Review the draft and publish manually** — `releases/latest/download/` does not resolve while a release is in draft.

One-time prerequisites:

- GitHub secret `TAURI_SIGNING_PRIVATE_KEY` = the **contents** (not the path) of `~/.tauri/omp-desktop.key`. **If this key is lost, already-installed users will never receive updates again.**
- Client-side signing is ad-hoc (`APPLE_SIGNING_IDENTITY: "-"`). First-time installs need a right-click open, or `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`. Removing this step requires an Apple Developer ID ($99/year) plus notarization — see [ADR-0003](.agents/notes/0003-tauri-updater-auto-update.md).

Local packaging (outside CI) also needs the key; with `createUpdaterArtifacts: true` a missing key fails hard and produces no bundles:

```bash
# Windows (in git-bash, ~/.tauri is the .tauri folder under your home directory)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
bun x tauri build --config src-tauri/tauri.windows.conf.json

# macOS
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
APPLE_SIGNING_IDENTITY="-" bun x tauri build
```

The key generated on macOS also works on Windows (the key itself is platform-independent, empty password); when switching machines, copy `~/.tauri/omp-desktop.key` + `.pub` into `~/.tauri/` on the new machine.

User-facing entry point: Settings → General → App → "Check for Updates".

## Documentation

- Dev constraints & site-wide conventions: [AGENTS.md](AGENTS.md)
- Documentation writing & lifecycle: [docs/documentation.md](docs/documentation.md)
- External-dependency pitfalls (omp SDK / Tauri / macOS): [docs/PITFALLS.md](docs/PITFALLS.md)
- Bug ledger / anti-regression rules / ADRs: `.agents/` (entry [.agents/README.md](.agents/README.md))
