// UI locale preference (the `ui` section of omp-desktop.json): read/write with
// a zh-CN default. The file lives under each profile's agent dir, so the
// preference is per-profile; applyProfile re-reads it on every profile apply
// and the set_locale RPC persists it (first explicit switch is the first write —
// a missing section never gets written back to disk by reads).
import { readFileSync, writeFileSync } from "node:fs";
import { H } from "./state.ts";
import type { HostLang } from "../ui-src/i18n/host.ts";

export const DEFAULT_UI_LOCALE: HostLang = "zh-CN";

// ---------- omp-desktop.json ui-section atomic read/write (keepalive-config pattern) ----------

/** Read omp-desktop.json in full (missing/corrupt file -> empty object, same tolerance as profile.ts). */
function readDesktopJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read the `ui` section (missing/invalid section -> empty object). */
function readSection(): Record<string, unknown> {
  const section = readDesktopJson().ui;
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** Merge-write the `ui` section, preserving other keys of omp-desktop.json and unmentioned fields inside the section. */
function writeSection(section: Record<string, unknown>): void {
  const raw = readDesktopJson();
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, ui: section }, null, 2));
}

/** Persisted UI locale (missing/invalid value falls back to zh-CN). */
export function readUiLocale(): HostLang {
  return readSection().locale === "en" ? "en" : DEFAULT_UI_LOCALE;
}

/** Persist the UI locale (set_locale RPC path: validate before calling). */
export function writeUiLocale(locale: HostLang): void {
  writeSection({ ...readSection(), locale });
}
