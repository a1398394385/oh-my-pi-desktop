// Frontend i18n entry: one i18next instance shared by the React tree and by
// non-component modules (stores / wsHandlers call the t() helper directly,
// no hook needed outside components).
// Lifecycle: main.tsx calls initI18n() before the first render; language
// switches re-mount the whole tree (<App key={lang}>, see main.tsx), so
// components simply re-read translated strings as they render.
// Settings-schema translations are NOT stored here — see locales/settings-zh-CN.ts
// (object values consumed via a schema-key fallback chain in SchemaRows).
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN";
import en from "./locales/en";

export type AppLang = "zh-CN" | "en";

// Resolve the startup language: stored preference first, otherwise detect
// from the system locale (zh* -> zh-CN, everything else -> en).
export function detectLang(stored: unknown): AppLang {
  if (stored === "zh-CN" || stored === "en") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "zh-CN";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

// Initialize before the first render (call exactly once per process start;
// language switches use i18next.changeLanguage instead).
export function initI18n(lang: AppLang): void {
  void i18next.use(initReactI18next).init({
    lng: lang,
    fallbackLng: "en",
    resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
    // React already escapes interpolated values.
    interpolation: { escapeValue: false },
  });
}

// Convenience for non-component layers: `import { t } from "../i18n"`.
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export default i18next;
