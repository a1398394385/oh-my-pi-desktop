export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: readonly (number | null)[];
  kind?: ChartKind;
  axis?: "left" | "right";
  pattern?: "hatch";
  dashed?: boolean;
  tooltip?: false;
}

export type ChartKind = "bars" | "area" | "line";

export interface ReferenceLine {
  value: number;
  label?: string;
  axis?: "left" | "right";
}
