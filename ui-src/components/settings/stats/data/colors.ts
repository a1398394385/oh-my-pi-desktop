/**
 * Categorical series colors for charts.
 */

export const SERIES_COLORS = [
  "#5ad8e6",
  "#ed4abf",
  "#9d7bff",
  "#f5b54a",
  "#4ade80",
  "#5b8cff",
  "#ff7a59",
  "#2dd4bf",
  "#c3e94f",
  "#fb7185",
];

export const OTHER_COLOR = "#6c6c74";

/**
 * Token mix palette (uncached input / cache read / cache write / output). Shared
 * by Overview and Providers so one token always reads as one color — cache read
 * is green here, not the accent blue, which would collide with uncached input.
 */
export const TOKEN_MIX_COLORS = {
  input: "#5b8cff",
  cacheRead: "#4ade80",
  cacheWrite: "#f5b54a",
  output: "var(--chart-secondary)",
} as const;

export function modelKey(model: string, provider: string): string {
  return `${model}::${provider}`;
}

export function buildModelColorLookup(
  records: readonly { model: string; provider: string; totalRequests: number }[],
): Map<string, string> {
  return buildColorLookup(
    records.map((record) => ({ key: modelKey(record.model, record.provider), weight: record.totalRequests })),
  );
}

export function buildColorLookup(items: readonly { key: string; weight: number }[]): Map<string, string> {
  const ranked = [...items].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  return new Map(ranked.map((item, index) => [item.key, SERIES_COLORS[index % SERIES_COLORS.length]]));
}
