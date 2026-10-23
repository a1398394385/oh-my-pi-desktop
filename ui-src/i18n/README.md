# i18n

UI and host-process user-facing strings live in language packs under this
directory. Hardcoding user-visible strings in components / stores / host code
is forbidden — new copy must go through a pack.

## Layout

- `index.ts` — frontend i18next instance (React tree + non-component layers)
- `host.ts` — host-process i18next instance (Bun side; language comes from
  the `ui` section of omp-desktop.json, written by the `set_locale` RPC)
- `locales/zh-CN.ts`, `locales/en.ts` — UI strings (domain-prefixed keys)
- `locales/settings-zh-CN.ts` / `locales/settings-en.ts` — settings-page copy
  (object values `{label, description?, warning?}`, keyed by the raw settings
  key). The desktop owns both languages: every row the settings page renders
  has an entry in each pack, written for a human reader (see the copy rules
  below). The base schema (oh-my-pi) still ships English `ui.label` /
  `ui.description` and stays the fallback for keys a pack misses.
  `scripts/check-settings-copy.ts` (wired into `bun run check`) fails the build
  when one language has a description and the other does not, when a
  description is blank or over the length ceiling, and when descriptions that
  merely restate their own label increase.
- `locales/commands-zh-CN.ts` — built-in slash-command descriptions (same
  fallback: `en` uses the command's own English description)
- `locales/host-zh-CN.ts`, `locales/host-en.ts` — host message strings

## Conventions

- Keys: domain prefix + camelCase name, e.g. `composer.placeholder`,
  `sidebar.confirmDelete`, `chat.terminalCommands`
- Interpolation: `{{name}}`; plurals: pass `{ count }` and use `_one` / `_other`
  suffixes for English (`zh` has no plural forms, one key suffices)
- Language names in the language picker are always shown in their own language
  (简体中文 / English), never translated
- Time / date formatting goes through `Intl` formatters (auto locale-aware),
  never hand-rolled Chinese date strings

## Adding strings

1. Add the key to `locales/zh-CN.ts` and `locales/en.ts`
   (host messages: `locales/host-*.ts`)
2. Consume via `useTranslation` from `react-i18next` in components, or
   `import { t } from "../i18n"` in stores / wsHandlers / non-component code
3. Gates: `scripts/check-comment-language.mjs` ratchets Chinese comment
   lines down; a UI literal lint (no new hardcoded Chinese strings outside
   this directory) lands after the extraction wave

## Settings-page copy rules

Applies to `locales/settings-zh-CN.ts` / `locales/settings-en.ts` (rows rendered
from the settings schema) and to the desktop's own page copy in
`locales/ui/settingsPage.zh.ts` / `.en.ts` (the experimental / remote / MCP
pages, whose `*Desc` keys describe a feature rather than a schema row). A row
shows a label plus one description line; the description is the only place to
explain what a setting does.

1. **What it is, first** — the first sentence must make the feature
   understandable to someone who has never used it. Then the caveats the user
   acts on (platform limits, permissions, restart, billing, privacy).
2. **Effect, not mechanism** — say what the user gets, not how it is built.
   No "stage one", "lease", "heartbeat", "rollout", "payload", no API names
   (`WASAPI`, `ScreenCaptureKit`), no internal structure (band counts,
   singleton processes) — say "上下文", "记忆", "这一轮".
3. **Never restate the label** — the description adds what the label cannot:
   what changes, what breaks when it is off, when to touch it.
4. **Length** — Chinese ≤ 40 characters (≤ 60 for a genuinely complex item),
   English ≤ 25 words. A paragraph belongs in the docs, not in the row.
5. **Facts stay put** — values, ranges, defaults, option names, timing and
   side effects are copied from the base schema (`node_modules/@oh-my-pi/pi-coding-agent/src`)
   or the previous wording. A rewrite never invents or drops a fact.
6. **Both languages, written separately** — the English is not a translation of
   the Chinese; each reads like its own language.
7. **New keys** — the base ships settings the desktop does not show yet; when
   one shows up, add it to both packs, otherwise the Chinese UI shows the
   base's English text.
