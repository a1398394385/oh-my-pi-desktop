# Development

This document covers the architecture, how to run the app from source, and how releases are cut. For product-level docs see the [README](../README.md).

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

## Verification channels

Never present `?preview=1` (a sample-only page that does not connect to a host) as real-host verification. Pick a channel by what you need to prove:

- **`bun run dev:browser` (default channel)**: starts the host + Vite and prints `BROWSER_URL=http://localhost:<vite>/?ws=<port>`. The `?ws=` branch (`ui-src/store/ws.ts`) skips the Tauri `ws_url` and dials the main WS directly — no remote chapter, no write denylist; Tauri-only features (window controls, tray, native menu, audio, updates) no-op. Good for host protocol / UI logic / write paths, and it works headless.
- **CDP against the Tauri dev window (platform and shell verification)**: Windows WebView2-specific bugs, window controls, tray and real rendering differences must use this — Chromium rendering from the browser channel is not evidence. Start with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 bun run dev`, then attach the browser tool with `app.cdp_url: "http://127.0.0.1:9333"`. The Tauri dev window loads the `ui/dist` build (no devUrl, no HMR); run `bun run ui:watch` so rebuilt assets reload. This channel is **dev-only by design**: release builds ship no remote-inspect surface (`src-tauri/Cargo.toml` omits tauri's `devtools` feature, and the shell clears `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` in non-debug Windows builds), so a packaged app can never be driven by an external process — see RULE-015.
- **Remote control is a different shape**: the LAN server in `host/remote.ts` (16800 + `?t=` key) serves the `ui/dist` build under a write denylist. It never substitutes for development debugging.
- **Concurrency**: the main WS port is dynamic and Vite increments on collision, so instances do not clash on ports — but **one host per profile** (the session pool lives in process memory, the automations scheduler would double-fire, `omp-desktop.json` writes race). A second instance must use another `OMP_PROFILE` (e.g. `omp-desktop-dev-2`). The Tauri shell has a single-instance lock; the CDP / `dev:browser` channels do not, so they must not share the dev profile with `bun run dev`.

## Profile isolation (highest-priority constraint)

| Purpose | Profile | Entry point |
|---|---|---|
| All tests, smoke runs, probes, automation scripts | `omp-desktop-test` | `smokeEnv()` in `scripts/smoke-profile.ts` (SSOT) |
| Local development (`bun run dev`) | `omp-desktop-dev` | the `dev` script sets `OMP_PROFILE=omp-desktop-dev` |
| End users | `default` (`~/.omp/agent`) | installed app |

- Smoke scripts must go through `omp-desktop-test`: `import { smokeEnv } from "./smoke-profile.ts"` and use it to spawn the host and resolve profile paths (`profileAgentPath()`). Never hand-write a profile string or hardcode `~/.omp/agent/...`; a literal `OMP_PROFILE=omp-desktop-test bun scripts/...` is only for `package.json` entry points. Missing profile directories are created by `host/bootstrap.ts`.
- Development always uses `omp-desktop-dev`. It keeps its own `omp-desktop.json`, so its remote port/switch/accessKey are independent of `default` — a dev remote must avoid the `16800` that `default` may already hold.
- Never let tests or development runs pollute the `default` profile. `host/bootstrap.ts` hard-fails (`errors.host.profileRequired`) when a source tree runs against `default`.

## Host smoke scripts

The host can be verified standalone, without Tauri:

```bash
bun scripts/smoke.ts               # full-chain smoke against a real model (create session → prompt → persist → load & resume)
bun scripts/probe-sdk.ts           # assembly probe only
bun scripts/probe-asset-sources.ts # how source toggles constrain the asset list
```

More targeted smoke suites (queueing, subagents, plugins, provider order, …) live in `package.json` under `smoke:*` — see `scripts/` for the full list. All of them run under the `omp-desktop-test` profile.

## Checks

Full-repo checks:

```bash
bun run check
```

Covers: capabilities gate / frame fan-out gate / host boundaries / style token gate / architecture ratchet / comment language / encoding gate / omp imports / version consistency / i18n keys / settings copy / UI typecheck.

## Releasing

```bash
bun run version:set 0.2.0        # version SSOT lives in src-tauri/tauri.conf.json, mirrored to Cargo.toml automatically
git commit -am "release: 0.2.0"
git tag v0.2.0 && git push origin main --tags
```

The tag triggers `.github/workflows/release.yml`: it validates the tag against the version → builds per platform into a draft Release (updater artifacts and `latest.json`) → flips the draft to published in a separate `publish` job once every platform leg is green. The draft stage is what keeps `releases/latest/download/` (and therefore the updater) from ever pointing at a release whose assets are still uploading, so the publish step must stay a post-`build` job rather than `releaseDraft: false` on each leg.

### Signing key (one-time prerequisites)

- GitHub secret `TAURI_SIGNING_PRIVATE_KEY` = the **contents** (not the path) of `~/.tauri/omp-desktop.key`. **If this key is lost, already-installed users will never receive updates again.**
- Client-side signing is ad-hoc (`APPLE_SIGNING_IDENTITY: "-"`). First-time installs need a right-click open, or `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`. Removing this step requires an Apple Developer ID ($99/year) plus notarization — see [ADR-0003](../.agents/notes/0003-tauri-updater-auto-update.md).

### Local packaging

Building outside CI also needs the key; with `createUpdaterArtifacts: true` a missing key fails hard and produces no bundles:

```bash
# Windows (in git-bash, ~/.tauri is the .tauri folder under your home directory)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
bun x tauri build --config src-tauri/tauri.windows.conf.json

# macOS
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
APPLE_SIGNING_IDENTITY="-" bun x tauri build
```

The key generated on macOS also works on Windows (the key itself is platform-independent, empty password); when switching machines, copy `~/.tauri/omp-desktop.key` + `.pub` into `~/.tauri/` on the new machine.

User-facing update entry point: Settings → General → App → "Check for Updates".

## Documentation map

- Dev constraints & site-wide conventions: [AGENTS.md](../AGENTS.md)
- Documentation writing & lifecycle: [docs/documentation.md](documentation.md)
- External-dependency pitfalls (omp SDK / Tauri / macOS): [docs/PITFALLS.md](PITFALLS.md)
- Bug ledger / anti-regression rules / ADRs: `.agents/` (entry [.agents/README.md](../.agents/README.md))
