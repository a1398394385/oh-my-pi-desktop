// Cross-domain pure formatting helpers (stateless, moved over from store.ts; P3 wave 2)
import { t } from "../i18n";
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// Last path segment (display name for projects / dirs / files): recognizes both POSIX and Windows
// separators and strips trailing separators.
// Examples: "C:\Users\x\proj\" → "proj", "/a/b" → "b"; a string made entirely of separators (root)
// is returned as-is. The old split("/") did not split Windows paths at all, so project names
// showed as full paths.
export function pathBase(p: string | null | undefined): string {
  const raw = String(p ?? "");
  const s = raw.replace(/[/\\]+$/, "");
  if (!s) return raw;
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
}

// Duration formatting (milliseconds): seconds / min-sec / hour-min (moved over from fmtDurationMs in settings/StatsPage, shared across pages)
export function fmtDurationMs(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return t("notify.durationSec", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("notify.durationMinSec", { n: m, m: s % 60 });
  const h = Math.floor(m / 60);
  return t("notify.durationHourMin", { n: h, m: m % 60 });
}
