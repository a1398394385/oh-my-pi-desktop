/**
 * Spotlight page vocabulary: recovery kinds, cut groups and tool icons, plus the
 * signed number formatting the page's cards share.
 *
 * Labels and rules are i18n keys, not prose: every card renders them through
 * `t`, so the copy lives in the settingsPage packs (one entry per language).
 */
import {
  Archive,
  Bot,
  Braces,
  CloudDownload,
  Ellipsis,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  FolderSearch,
  Globe,
  Hourglass,
  type LucideIcon,
  ListTodo,
  Network,
  Repeat2,
  ScanSearch,
  SquareTerminal,
  TextSearch,
  Wrench,
} from "lucide-react";
import { formatCompact, formatCost } from "../data/formatters";
import type {
  SpotlightCutGroup,
  SpotlightDashboardStats,
  SpotlightEstimate,
  SpotlightGapBin,
  SpotlightRecoveryKind,
  SpotlightSizeBin,
  SpotlightTool,
} from "../types";

export const RECOVERY_KINDS: readonly SpotlightRecoveryKind[] = ["artifact", "reread", "rerun"];

export interface RecoveryKindMeta {
  /** i18n key suffix under `settingsPage.stats.spotlight.meta.recovery`. */
  key: string;
  icon: LucideIcon;
  color: string;
}

export const RECOVERY_KIND: Record<SpotlightRecoveryKind, RecoveryKindMeta> = {
  artifact: { key: "artifact", icon: Archive, color: "var(--chart-secondary)" },
  reread: { key: "reread", icon: FileSearch, color: "var(--chart-primary)" },
  rerun: { key: "rerun", icon: Repeat2, color: "var(--orange)" },
};

/** The range's evaluated tools, the largest saving first (the order of `gross.byTool`). */
export function toolsBySaving(stats: SpotlightDashboardStats): SpotlightTool[] {
  return stats.gross.byTool.map(row => row.tool);
}

/** Tools a card lists by name before the rest fold into `other`. */
export const TOP_TOOLS = 6;

/** The folded rest's label where tools are rows or columns. */
export const OTHER_TOOLS = "other";

/**
 * Split tools (ordered) into the first `limit` a card lists and the rest it folds; a
 * lone leftover is listed instead.
 */
export function foldTools<T>(items: readonly T[], limit = TOP_TOOLS): { listed: readonly T[]; rest: readonly T[] } {
  if (items.length <= limit + 1) return { listed: items, rest: [] };
  return { listed: items.slice(0, limit), rest: items.slice(limit) };
}

export interface CutGroupMeta {
  /** i18n key suffix under `settingsPage.stats.spotlight.meta.cutGroup`. */
  key: string;
  color: string;
}

/**
 * The fetch-back comparison's groups: the cut is vivid, the score-free cut (same
 * shaping without Spotlight's scores) takes its own hue, and the baselines are
 * neutral inks with the held-out one (the true counterfactual) the stronger.
 */
export const CUT_GROUP: Record<SpotlightCutGroup, CutGroupMeta> = {
  applied: { key: "applied", color: "var(--green)" },
  scoreFree: { key: "scoreFree", color: "var(--orange)" },
  holdout: { key: "holdout", color: "var(--purple)" },
  gated: { key: "gated", color: "var(--faint)" },
  reference: { key: "reference", color: "var(--dim)" },
};

export const CUT_GROUPS: readonly SpotlightCutGroup[] = ["applied", "scoreFree", "holdout", "gated", "reference"];

export const SIZE_BINS: readonly SpotlightSizeBin[] = ["<250", "250–1k", "1k–4k", "≥4k"];

export const GAP_BINS: readonly SpotlightGapBin[] = ["1", "2", "3", "4–6", "7–12"];

const TOOL_ICON: Readonly<Record<string, LucideIcon>> = {
  read: FileText,
  bash: SquareTerminal,
  eval: Braces,
  grep: TextSearch,
  find: ScanSearch,
  glob: FolderSearch,
  edit: FilePenLine,
  write: FilePlus,
  web_search: Globe,
  task: Bot,
  todo: ListTodo,
  wait: Hourglass,
  fetch: CloudDownload,
  lsp: Network,
  [OTHER_TOOLS]: Ellipsis,
};

/** A tool's icon; tools without one of their own (MCP and extension tools) get a wrench. */
export function toolIcon(tool: SpotlightTool): LucideIcon {
  return Object.hasOwn(TOOL_ICON, tool) ? TOOL_ICON[tool] : Wrench;
}

/** Compact token count with a real minus sign. */
export function formatSignedCompact(value: number): string {
  // `=== 0` also catches -0, which would otherwise print as "−0".
  if (value === 0) return formatCompact(0);
  return value < 0 ? `−${formatCompact(-value)}` : formatCompact(value);
}

/** Dollar amount with a real minus sign (`formatCost` alone prints `$-0.12`). */
export function formatSignedCost(value: number): string {
  if (value === 0) return formatCost(0);
  return value < 0 ? `−${formatCost(-value)}` : formatCost(value);
}

/** A relative change as a signed percentage (`+12%`, `−3.5%`), `–` when undefined. */
export function formatSignedShare(value: number | null): string {
  return value !== null && value > 0 ? `+${formatShare(value)}` : formatShare(value);
}

/** An estimate's 90% interval as `lo–hi`, empty when it has none. */
export function formatInterval(estimate: SpotlightEstimate, format: (value: number) => string): string {
  return estimate.lo === null || estimate.hi === null ? "" : `${format(estimate.lo)}–${format(estimate.hi)}`;
}

/** Share as a whole or one-decimal percentage, `–` when undefined. */
export function formatShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  if (value === 0) return "0%";
  const pct = value * 100;
  return `${Math.abs(pct) >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}
