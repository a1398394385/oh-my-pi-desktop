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
