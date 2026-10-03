import { format } from "@oh-my-pi/pi-utils/dates";
import { t } from "../../../../i18n";
import type { TimeRange } from "../types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface RangeMeta {
  label: string;
  windowLabel: string;
  spanMs: number | null;
  bucketMs: number;
}

// Static bucket/span configuration per range. User-facing labels are not
// stored here: rangeMeta resolves them via t() at call time (it is invoked
// from component render, never at module load) so language switches apply.
const RANGE_META: Record<TimeRange, Pick<RangeMeta, "spanMs" | "bucketMs">> = {
  "1h": { spanMs: HOUR_MS, bucketMs: 5 * MINUTE_MS },
  "24h": { spanMs: DAY_MS, bucketMs: HOUR_MS },
  "7d": { spanMs: 7 * DAY_MS, bucketMs: DAY_MS },
  "30d": { spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
  "90d": { spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
  all: { spanMs: null, bucketMs: DAY_MS },
};

const MAX_BUCKETS = 1500;

export const TIME_RANGES: readonly TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

export function rangeMeta(range: TimeRange): RangeMeta {
  return {
    ...RANGE_META[range],
    label: t(`settingsPage.stats.range.short.${range}`),
    windowLabel: t(`settingsPage.stats.range.window.${range}`),
  };
}

export function formatBucket(timestamp: number, bucketMs: number): string {
  if (bucketMs < DAY_MS) return format(new Date(timestamp), bucketMs < HOUR_MS ? "HH:mm" : "MMM d HH:mm");
  return format(new Date(timestamp), "MMM d");
}

export function formatTick(timestamp: number, bucketMs: number): string {
  if (bucketMs < DAY_MS) return format(new Date(timestamp), "HH:mm");
  return format(new Date(timestamp), "MMM d");
}

export function bucketAxis(
  range: TimeRange,
  dataTimestamps: Iterable<number>,
  bucketMs = RANGE_META[range].bucketMs,
  now = Date.now(),
): number[] {
  const last = Math.floor(now / bucketMs) * bucketMs;
  const span = RANGE_META[range].spanMs;
  let first: number;
  if (span !== null) {
    first = Math.floor((now - span) / bucketMs) * bucketMs;
  } else {
    first = last;
    for (const ts of dataTimestamps) if (ts < first) first = ts;
    first = Math.floor(first / bucketMs) * bucketMs;
  }
  first = Math.max(first, last - (MAX_BUCKETS - 1) * bucketMs);
  const buckets: number[] = [];
  for (let t = first; t <= last; t += bucketMs) buckets.push(t);
  return buckets;
}
