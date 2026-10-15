import { formatBucket, formatTick } from "../data/range";
import { Chart, type ChartProps } from "./Chart";

export interface TimeChartProps extends Omit<ChartProps, "slots" | "tickLabel" | "tooltipTitle" | "onSelect"> {
  buckets: readonly number[];
  bucketMs: number;
  onSelectBucket?: (bucketStart: number) => void;
}

export function TimeChart({ buckets, bucketMs, onSelectBucket, ...rest }: TimeChartProps) {
  return (
    <Chart
      {...rest}
      slots={buckets.length}
      tickLabel={(i) => formatTick(buckets[i], bucketMs)}
      tooltipTitle={(i) => formatBucket(buckets[i], bucketMs)}
      onSelect={onSelectBucket ? (i) => onSelectBucket(buckets[i]) : undefined}
    />
  );
}
