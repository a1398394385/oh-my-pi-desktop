// Right panel shared utilities: fmtAgo.
import { t } from "../../../i18n";
// The same-named implementation in sidebar.js imports the old core.js — esbuild bundling
// would drag the whole imperative UI tree's top-level side effects (window.onerror etc.)
// into the React bundle, conflicting with store.js, hence this equivalent implementation.
/** Relative time (same keyed implementation as sidebar/util.ts, compact style) */
export function fmtAgo(iso: string): string {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return t("sidebar.agoNow");
  if (sec < 3600) return t("sidebar.agoMin", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("sidebar.agoHour", { n: Math.floor(sec / 3600) });
  return t("sidebar.agoDay", { n: Math.floor(sec / 86400) });
}
