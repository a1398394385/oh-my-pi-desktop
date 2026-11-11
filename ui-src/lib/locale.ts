// Interface language for date/number formatting. i18next carries the UI language,
// but Intl/toLocale* default to the system locale — pass appLocale() at every such
// call so one screen never mixes two languages (BUG-134).
import type { AppLang } from "../i18n";
import { useAppStore } from "../store";

export function appLocale(): AppLang {
  return useAppStore.getState().uiPrefs.lang;
}

/**
 * Date/time formatter bound to the current UI language. The Intl instance is
 * rebuilt when the language changes: <App key={lang}> remounts components but
 * never re-runs module top-level code, so a module-level
 * `new Intl.DateTimeFormat(...)` would stay frozen on the startup language.
 */
export function localeDate(options: Intl.DateTimeFormatOptions): (date: Date | number) => string {
  let cache: { lang: AppLang; fmt: Intl.DateTimeFormat } | undefined;
  return (date) => {
    const lang = appLocale();
    if (!cache || cache.lang !== lang) cache = { lang, fmt: new Intl.DateTimeFormat(lang, options) };
    return cache.fmt.format(date);
  };
}
