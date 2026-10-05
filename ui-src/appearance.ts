// Appearance preferences: applied to documentElement (CSS variables and
// dataset switches) and persisted file-first — omp-desktop.json's ui section
// is the single source of truth, mirrored into localStorage as the first-frame
// render cache (write-through on save, reconciled against the file on every
// ready/settings frame). Shared by the settings pages (Settings container),
// global shortcuts (keys.js) and the frame handlers (wsHandlers/config).
import i18next from "./i18n";
import { useAppStore, send } from "./store";
import { invoke } from "./store/ws";
import { applyTheme, applyMotion } from "./shell";
import type { UiPrefs } from "./store/shapes";
import { resolveTheme } from "./theme-registry";

const UI_PREF_KEY = "omp-ui-settings";
const THEME_KEY = "omp-theme";
const MOTION_KEY = "omp-motion";

// Font options: shared by the appearance page font dropdown and applyAppearance
export const FONT_STACKS: Record<string, string> = {
  default: "var(--sans)",
  zcode: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** Cache-mirror the current prefs (+lang) into omp-ui-settings; theme/motion have their own keys. */
function mirrorPrefsCache(prefs: UiPrefs): void {
  const { theme: _t, motion: _m, ...cached } = prefs;
  try { localStorage.setItem(UI_PREF_KEY, JSON.stringify(cached)); } catch {}
}

/** Persist appearance prefs: write omp-desktop.json via set_ui_prefs + mirror the localStorage cache. */
export function saveUiPrefs(): void {
  mirrorPrefsCache(useAppStore.getState().uiPrefs);
  const { theme: _t, motion: _m, lang: _l, ...prefs } = useAppStore.getState().uiPrefs;
  send({ type: "set_ui_prefs", prefs });
}

/** Persist the locale in the first-frame cache without requesting an appearance settings ack. */
export function saveUiLocale(): void {
  mirrorPrefsCache(useAppStore.getState().uiPrefs);
}

// Appearance preferences -> documentElement CSS variables and dataset switches
export function applyAppearance(): void {
  const { uiPrefs } = useAppStore.getState();
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}

// The purely-appearance side effects of host settings: only hideThinkingBlock
// affects appearance -- synced into uiPrefs.showThinking, persisted and applied.
// The other host fields (proxy/timeouts/toggles) are rendered under control by
// page components with S.hostSettings as the data source.
export function applyHostAppearance(hostSettings: { hideThinkingBlock?: unknown } | null | undefined): void {
  if (!hostSettings || typeof hostSettings.hideThinkingBlock !== "boolean") return;
  const showThinking = !hostSettings.hideThinkingBlock;
  // Write a new object (selector components sense it by reference) + _v bump
  // (old useStore subscription fallback)
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking } }));
  saveUiPrefs();
  applyAppearance();
}

/** Narrow a frame-side prefs object to the known UiPrefs appearance fields (invalid values dropped). */
function prefsProjection(src: unknown): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {};
  if (!src || typeof src !== "object") return out;
  const s = src as Record<string, unknown>;
  if (typeof s.uiFont === "string") out.uiFont = s.uiFont;
  if (typeof s.uiFontSize === "number" && s.uiFontSize >= 11 && s.uiFontSize <= 18) out.uiFontSize = s.uiFontSize;
  if (typeof s.codeFontSize === "number" && s.codeFontSize >= 10 && s.codeFontSize <= 18) out.codeFontSize = s.codeFontSize;
  if (typeof s.lineNumbers === "boolean") out.lineNumbers = s.lineNumbers;
  if (typeof s.codeWrap === "boolean") out.codeWrap = s.codeWrap;
  if (typeof s.showThinking === "boolean") out.showThinking = s.showThinking;
  if (typeof s.expandToolOutput === "boolean") out.expandToolOutput = s.expandToolOutput;
  if (typeof s.terminalInheritProfile === "boolean") out.terminalInheritProfile = s.terminalInheritProfile;
  if (typeof s.terminalFont === "string") out.terminalFont = s.terminalFont;
  return out;
}

/**
 * Reconcile uiPrefs against the ready/settings frame's uiConfig (read from
 * omp-desktop.json on the host — the authoritative view). Per dimension:
 * file value wins -> apply + refresh the localStorage cache; file empty but
 * cache warm -> one-time migration upload (the ack frame then lands as a
 * normal reconcile). The locale dimension additionally repairs the "detected
 * language was pushed over the file's explicit choice" startup window.
 */
// Default prefs baseline (migration check: only upload when a cached value differs)
const DEFAULT_PREFS: Record<string, unknown> = {
  uiFont: "default",
  uiFontSize: 13,
  codeFontSize: 12,
  lineNumbers: true,
  codeWrap: false,
  showThinking: true,
  expandToolOutput: true,
  terminalInheritProfile: true,
  terminalFont: "",
};

export function applyUiConfig(cfg: unknown): void {
  if (!cfg || typeof cfg !== "object") return;
  const c = cfg as { locale?: unknown; theme?: unknown; motion?: unknown; prefs?: unknown };

  // theme: file wins; cache-only value migrates up once
  // Only apply if it's a valid theme (built-in or custom theme ID from THEMES)
  if (typeof c.theme === "string" && c.theme) {
    const theme = c.theme === "system" ? "system" : resolveTheme(c.theme);
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  } else {
    const cachedTheme = localStorage.getItem(THEME_KEY);
    if (cachedTheme) send({ type: "set_ui_prefs", theme: cachedTheme });
  }

  // motion: same shape as theme
  if (c.motion === "system" || c.motion === "on" || c.motion === "off") {
    applyMotion(c.motion);
    try { localStorage.setItem(MOTION_KEY, c.motion); } catch {}
  } else {
    const cachedMotion = localStorage.getItem(MOTION_KEY);
    if (cachedMotion) send({ type: "set_ui_prefs", motion: cachedMotion });
  }

  // prefs: file wins -> merge into the store + re-apply; cache-only value migrates up once
  const filePrefs = prefsProjection(c.prefs);
  if (Object.keys(filePrefs).length > 0) {
    useAppStore.setState(st => {
      const merged = { ...st.uiPrefs, ...filePrefs };
      mirrorPrefsCache(merged);
      return { uiPrefs: merged };
    });
    applyAppearance();
  } else {
    const { theme: _t, motion: _m, lang: _l, ...cachedPrefs } = useAppStore.getState().uiPrefs;
    // Only migrate when the cache actually carries a non-default change
    const hasAny = Object.entries(cachedPrefs).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULT_PREFS[k]));
    if (hasAny) send({ type: "set_ui_prefs", prefs: cachedPrefs });
  }

  // locale: an explicit file value beats the startup-detected language (the
  // onopen set_locale may have pushed the detection over it during the
  // cache-miss window — re-send to repair the file, then switch the UI)
  if ((c.locale === "zh-CN" || c.locale === "en") && c.locale !== useAppStore.getState().uiPrefs.lang) {
    const loc = c.locale;
    useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, lang: loc } }));
    void i18next.changeLanguage(loc);
    send({ type: "set_locale", lang: loc });
    invoke?.("set_menu_language", { lang: loc })?.catch((err: unknown) => console.warn("set_menu_language:", err));
  }
}
