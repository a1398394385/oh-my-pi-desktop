/**
 * Client-side type definitions for the stats dashboard.
 */

import type {
  AgentTypeStats,
  AggregatedStats,
  CostTimeSeriesPoint,
  ModelPerformancePoint,
  ModelStats,
  ModelTimeSeriesPoint,
  TimeSeriesPoint,
} from "@oh-my-pi/omp-stats/shared-types";

// The package root's type surface re-exports only a subset of shared-types
// (no AgentType*/Cost*/Trace*/SessionSummary); the official dashboard client
// imports from shared-types directly, so we mirror that here.
export * from "@oh-my-pi/omp-stats/shared-types";
// Gain dashboard: the host's stats server folds ACP compaction totals into
// /api/stats/gain (host/acp-gain.ts), so the gain types extend the base shape
// locally (local exports shadow the star re-export).
export type GainSource = "snapcompact" | "acp";
export interface GainTimeSeriesPoint {
  date: string;
  snapcompact: number;
  acp: number;
  total: number;
}
export interface GainSourceTotals {
  savedTokens: number;
  savedBytes: number;
  hits: number;
  outputBytes: number;
  originalBytes: number;
  reductionPercent: number | null;
}
export interface GainDashboardStats {
  overall: GainSourceTotals;
  bySource: Record<GainSource, GainSourceTotals>;
  timeSeries: GainTimeSeriesPoint[];
  project: string | null;
  projects: string[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  premiumRequests?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface MessageStats {
  id?: number;
  sessionFile: string;
  entryId: string;
  folder: string;
  model: string;
  provider: string;
  api: string;
  timestamp: number;
  duration: number | null;
  ttft: number | null;
  stopReason: string;
  errorMessage: string | null;
  usage: Usage;
  costUnpriced?: boolean;
}

export interface RequestDetails extends MessageStats {
  messages: unknown[];
  output: unknown;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

/** One ACP compression (host/acp-stats.ts AcpCompactionRow), served by /api/stats/acp. */
export interface AcpCompactionRow {
  id: string;
  createdAt: number;
  model: string;
  cwd: string | null;
  compressedTokens: number;
  activeTokensAfter: number;
  /** null on journals written before the runtime recorded the telemetry. */
  summaryTokens: number | null;
  statusTokens: number | null;
  hints: number | null;
  extraTokens: number;
  extraCost: number;
  requestsAfter: number;
  savedTokens: number;
  savedCost: number;
}

export interface OverviewStats {
  overall: AggregatedStats;
  byAgentType: AgentTypeStats[];
  timeSeries: TimeSeriesPoint[];
}

export interface ModelDashboardStats {
  byModel: ModelStats[];
  modelSeries: ModelTimeSeriesPoint[];
  modelPerformanceSeries: ModelPerformancePoint[];
}

export interface CostDashboardStats {
  costSeries: CostTimeSeriesPoint[];
}
