// Frontend i18n entry: one i18next instance shared by the React tree and by
// non-component modules (stores / wsHandlers call the t() helper directly,
// no hook needed outside components).
// Lifecycle: main.tsx awaits initI18n() before the first render; language
// switches re-mount the whole tree (<App key={lang}>, see main.tsx), so
// components simply re-read translated strings as they render.
// Settings-schema translations are NOT stored here — see locales/settings-zh-CN.ts
// (object values consumed via a schema-key fallback chain in SchemaRows).
import i18next, { type BackendModule, type ReadCallback, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

export type AppLang = "zh-CN" | "en";

// Resolve the startup language: stored preference first, otherwise detect
// from the system locale (zh* -> zh-CN, everything else -> en).
export function detectLang(stored: unknown): AppLang {
  if (stored === "zh-CN" || stored === "en") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "zh-CN";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

// Language packs are code-split: statically bundling both locales put ~267KB
// of strings in the startup closure while every session reads only one. The
// custom backend routes init AND i18next.changeLanguage through the same lazy
// import, so existing changeLanguage callers need no changes.
const PACK_LOADERS: Record<AppLang, () => Promise<{ default: Resource }>> = {
  "zh-CN": () => import("./locales/zh-CN"),
  en: () => import("./locales/en"),
};

const lazyPackBackend: BackendModule = {
  type: "backend",
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const load = PACK_LOADERS[language as AppLang];
    if (!load) {
      callback(new Error(`no language pack for '${language}'`), null);
      return;
    }
    void load().then(
      (mod) => callback(null, mod.default),
      (err) => callback(err, null),
    );
  },
};


// Call exactly once per process start and await it before rendering. Language
// switches go through i18next.changeLanguage, served by the same backend.
// fallbackLng is off because check:i18n-keys enforces key parity between the
// two packs, and a fallback would eagerly pull the other language's chunk.
export async function initI18n(lang: AppLang): Promise<void> {
  await i18next
    .use(lazyPackBackend)
    .use(initReactI18next)
    .init({
      lng: lang,
      fallbackLng: false,
      load: "currentOnly",
      // React already escapes interpolated values.
      interpolation: { escapeValue: false },
    });
}

// Convenience for non-component layers: `import { t } from "../i18n"`.
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export default i18next;
