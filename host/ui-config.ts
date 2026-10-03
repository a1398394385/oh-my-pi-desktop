// UI config (the `ui` section of omp-desktop.json): locale + theme + motion +
// appearance prefs. The file lives under each profile's agent dir, so every key
// is per-profile; applyProfile re-reads the locale on every profile apply, the
// set_locale / set_ui_prefs RPCs persist values (a missing section never gets
// written back to disk by reads — first explicit change is the first write).
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

// ---------- theme / motion / appearance prefs (the set_ui_prefs RPC path) ----------

export type UiThemeMode = "dark" | "light" | "system";
export type UiMotionMode = "system" | "on" | "off";

/** Legal theme values (anything else on disk reads back as undefined -> the frontend falls back). */
const THEME_MODES: Record<string, true> = { dark: true, light: true, system: true };
/** Legal motion values (same tolerance as theme). */
const MOTION_MODES: Record<string, true> = { system: true, on: true, off: true };

/**
 * Known prefs fields with their validators. Mirrors the frontend UiPrefs shape
 * minus theme/motion/lang (theme/motion live as ui-section siblings, lang is
 * the separate `locale` key). Unknown keys are dropped on write AND on read —
 * the file section stays a typed projection, never a passthrough blob.
 */
const PREFS_FIELDS: Record<string, (v: unknown) => unknown> = {
  uiFont: v => (typeof v === "string" ? v : undefined),
  uiFontSize: v => (typeof v === "number" && Number.isInteger(v) && v >= 11 && v <= 18 ? v : undefined),
  codeFontSize: v => (typeof v === "number" && Number.isInteger(v) && v >= 10 && v <= 18 ? v : undefined),
  lineNumbers: v => (typeof v === "boolean" ? v : undefined),
  codeWrap: v => (typeof v === "boolean" ? v : undefined),
  showThinking: v => (typeof v === "boolean" ? v : undefined),
  expandToolOutput: v => (typeof v === "boolean" ? v : undefined),
  terminalInheritProfile: v => (typeof v === "boolean" ? v : undefined),
  terminalFont: v => (typeof v === "string" ? v : undefined),
};

/** Filter an unknown prefs object down to known fields with valid types (invalid fields are skipped). */
function sanitizePrefs(src: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== "object") return out;
  for (const [k, check] of Object.entries(PREFS_FIELDS)) {
    const v = check((src as Record<string, unknown>)[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** ui-section projection carried by the settings/ready frames (source of truth for the frontend cache). */
export interface UiConfig {
  /** Explicit file value only — undefined means "never set" (the frontend keeps its detected language; readUiLocale stays the fallback source for host i18n). */
  locale?: HostLang;
  theme?: UiThemeMode;
  motion?: UiMotionMode;
  prefs: Record<string, unknown>;
}

/** Read the ui-section projection for frames: only legal values come out, everything else stays undefined. */
export function readUiConfig(): UiConfig {
  const section = readSection();
  const locale = section.locale;
  const theme = section.theme;
  const motion = section.motion;
  return {
    locale: locale === "en" || locale === "zh-CN" ? locale : undefined,
    theme: typeof theme === "string" && THEME_MODES[theme] ? (theme as UiThemeMode) : undefined,
    motion: typeof motion === "string" && MOTION_MODES[motion] ? (motion as UiMotionMode) : undefined,
    prefs: sanitizePrefs(section.prefs),
  };
}

/**
 * Persist a ui-section patch from the set_ui_prefs RPC: theme/motion/prefs are
 * each optional; fields with invalid values are skipped (same semantics as
 * set_keepalive_config), other keys of the section and the file are preserved.
 */
export function writeUiPrefs(patch: { theme?: unknown; motion?: unknown; prefs?: unknown }): void {
  const next: Record<string, unknown> = { ...readSection() };
  if (patch.theme !== undefined && typeof patch.theme === "string" && THEME_MODES[patch.theme]) {
    next.theme = patch.theme;
  }
  if (patch.motion !== undefined && typeof patch.motion === "string" && MOTION_MODES[patch.motion]) {
    next.motion = patch.motion;
  }
  if (patch.prefs !== undefined) {
    next.prefs = {
      ...(typeof next.prefs === "object" && next.prefs ? next.prefs : {}),
      ...sanitizePrefs(patch.prefs),
    };
  }
  writeSection(next);
}
