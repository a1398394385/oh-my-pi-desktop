// Host-process i18n: a dedicated i18next instance for the Bun host, separate
// from the frontend instance (different processes, separate lifecycles).
// Language source of truth: the `ui` section of omp-desktop.json (written by
// the set_locale RPC). Bootstrap calls initHostI18n() with the persisted
// value at startup; the RPC switches it at runtime.
// NOTE: consumed from host/ via a relative import; host code is outside
// tsconfig — validate host-side changes with `bun build --external "*"` + smoke.
import { createInstance } from "i18next";
import errorsZh from "./locales/host-errors.zh-CN";
import errorsEn from "./locales/host-errors.en";
import flowsZh from "./locales/host-flows.zh-CN";
import flowsEn from "./locales/host-flows.en";

export type HostLang = "zh-CN" | "en";

export const hostI18n = createInstance();

void hostI18n.init({
  lng: "zh-CN",
  fallbackLng: "en",
  resources: {
    // Namespace wrappers are required: callers address keys as
    // t("errors.*") / t("flows.*"), the locale files export the inner objects.
    "zh-CN": { translation: { errors: errorsZh, flows: flowsZh } },
    en: { translation: { errors: errorsEn, flows: flowsEn } },
  },
  interpolation: { escapeValue: false },
});

// Switch the host language (bootstrap start + set_locale RPC).
export function initHostI18n(lang: HostLang): void {
  void hostI18n.changeLanguage(lang);
}

export default hostI18n;
