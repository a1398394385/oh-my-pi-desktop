import { format, formatDistanceToNow } from "@oh-my-pi/pi-utils/dates";
import { t } from "../../../../i18n";
import type { MessageStats } from "../types";

const NUMBER_LOCALE = "en-US";

export function formatInteger(value: number): string {
  return value.toLocaleString(NUMBER_LOCALE);
}

export function formatCompact(value: number): string {
  return value.toLocaleString(NUMBER_LOCALE, { notation: "compact" });
}

export function formatCost(value: number, digits?: number): string {
  if (value === 0) return "$0";
  const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function formatEstimatedCost(value: number, unpricedRequests: number, digits?: number): string {
  return value === 0 && unpricedRequests > 0 ? t("settingsPage.stats.charts.notAvailable") : formatCost(value, digits);
}

export function isUnpricedMessage(message: Pick<MessageStats, "provider" | "usage" | "costUnpriced">): boolean {
  return (
    message.usage.totalTokens > 0 &&
    message.usage.cost.total === 0 &&
    (message.provider === "xai-oauth" || message.costUnpriced === true)
  );
}

export function formatMessageCost(
  message: Pick<MessageStats, "provider" | "usage" | "costUnpriced">,
  digits?: number,
): string {
  return formatEstimatedCost(message.usage.cost.total, isUnpricedMessage(message) ? 1 : 0, digits);
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDurationMs(value: number | null, digits?: number): string {
  if (value === null) return "-";
  const sec = value / 1000;
  const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
  return `${sec.toFixed(d)}s`;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return formatDurationMs(ms);
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

export function formatTokensPerSecond(value: number | null): string {
  if (value === null) return "-";
  return value.toFixed(1);
}

export function formatRelativeTime(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

export function formatTimestamp(timestamp: number): string {
  return format(new Date(timestamp), "MMM d, HH:mm:ss");
}

export function formatFolder(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, "") || t("settingsPage.stats.charts.rootFolder");
}

export function formatBytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
  return `${value} B`;
}
