// Right panel shared utilities: escapeHtml / fmtAgo / inlineCodeHtml.
import { t } from "../../i18n";
// The same-named implementations in markdown.js (escapeHtml), sidebar.js (fmtAgo) and
// tool-rows.js (fillInlineCode) all import the old core.js — esbuild bundling would drag the
// whole imperative UI tree's top-level side effects (window.onerror etc.) into the React
// bundle, conflicting with store.js, hence these equivalent implementations.
/** HTML escaping (equivalent of markdown.js escapeHtml) */
export function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Relative time (same keyed implementation as sidebar/util.ts, compact style) */
export function fmtAgo(iso: string): string {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return t("sidebar.agoNow");
  if (sec < 3600) return t("sidebar.agoMin", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("sidebar.agoHour", { n: Math.floor(sec / 3600) });
  return t("sidebar.agoDay", { n: Math.floor(sec / 86400) });
}

/** `backtick` spans → <code> (HTML version of tool-rows.js fillInlineCode, for step-title innerHTML injection) */
export function inlineCodeHtml(text: unknown): string {
  return String(text || "")
    .split(/(`[^`]+`)/)
    .map((p) =>
      p.length > 2 && p.startsWith("`") && p.endsWith("`")
        ? `<code>${escapeHtml(p.slice(1, -1))}</code>`
        : escapeHtml(p),
    )
    .join("");
}
