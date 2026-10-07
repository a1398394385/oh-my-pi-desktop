# i18n

UI and host-process user-facing strings live in language packs under this
directory. Hardcoding user-visible strings in components / stores / host code
is forbidden — new copy must go through a pack.

## Layout

- `index.ts` — frontend i18next instance (React tree + non-component layers)
- `host.ts` — host-process i18next instance (Bun side; language comes from
  the `ui` section of omp-desktop.json, written by the `set_locale` RPC)
- `locales/zh-CN.ts`, `locales/en.ts` — UI strings (domain-prefixed keys)
- `locales/settings-zh-CN.ts` — settings-schema translations (object values
  `{label, description?, warning?}`). `en` falls back to the schema's own
  `ui.label` English text — but keys whose registry entry carries no `ui`
  metadata (skills.*/memories.*/mnemopi.*/hindsight.*/sharpshooter.* …) would
  render the raw key, so they carry real entries in `settings-en.ts`
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
