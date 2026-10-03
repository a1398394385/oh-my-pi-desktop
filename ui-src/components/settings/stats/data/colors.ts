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
