import type {
  AgentType,
  AgentTypeStats,
  CostTimeSeriesPoint,
  FolderStats,
  MessageStats,
  ModelPerformancePoint,
  ToolUsageStats,
} from "../types";
import { modelKey } from "./colors";
import { isUnpricedMessage } from "./formatters";
import { t } from "../../../../i18n";

const AGENT_TYPE_ORDER: AgentType[] = ["main", "subagent", "advisor"];

export interface ConversationTokenStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export function sumConversationTokens(stats: ConversationTokenStats): number {
  return stats.totalInputTokens + stats.totalOutputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens;
}

export interface AgentTokenSegment {
  agentType: AgentType;
  tokens: number;
  requests: number;
  cost: number;
  share: number;
}

export interface AgentTokenShareView {
  totalTokens: number;
  totalCost: number;
  segments: AgentTokenSegment[];
}

export function buildAgentTokenShare(stats: AgentTypeStats[]): AgentTokenShareView {
  const byType = new Map<AgentType, AgentTypeStats>();
  for (const stat of stats) byType.set(stat.agentType, stat);

  const present = AGENT_TYPE_ORDER.map((type) => byType.get(type)).filter(
    (stat): stat is AgentTypeStats => stat !== undefined,
  );
  const totalTokens = present.reduce((sum, stat) => sum + sumConversationTokens(stat), 0);
  const totalCost = present.reduce((sum, stat) => sum + stat.totalCost, 0);

  const segments = present.map((stat) => {
    const tokens = sumConversationTokens(stat);
    return {
      agentType: stat.agentType,
      tokens,
      requests: stat.totalRequests,
      cost: stat.totalCost,
      share: totalTokens > 0 ? tokens / totalTokens : 0,
    };
  });

  return { totalTokens, totalCost, segments };
}

export interface CostComponents {
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

export interface CostModelRow extends CostComponents {
  key: string;
  model: string;
  provider: string;
  cost: number;
  requests: number;
  unpricedRequests: number;
  share: number;
}

export interface CostSummaryView extends CostComponents {
  totalCost: number;
  requests: number;
  unpricedRequests: number;
  activeDays: number;
  avgDailyCost: number;
  models: CostModelRow[];
  topModel: CostModelRow | null;
}

export interface ModelPerformanceDataPoint {
  timestamp: number;
  avgTtftSeconds: number | null;
  avgTokensPerSecond: number | null;
  requests: number;
}

export interface FolderRowView extends FolderStats {
  conversationTokens: number;
  requestShare: number;
  costShare: number;
  temporary: boolean;
}

export interface FolderTableView {
  rows: FolderRowView[];
  totalRequests: number;
  failedRequests: number;
  totalCost: number;
  unpricedRequests: number;
  conversationTokens: number;
  cacheRate: number;
  maxRequests: number;
  maxCost: number;
  temporaryCount: number;
}

export function buildCostSummary(costSeries: readonly CostTimeSeriesPoint[]): CostSummaryView {
  const summary: CostSummaryView = {
    totalCost: 0,
    requests: 0,
    unpricedRequests: 0,
    activeDays: new Set(costSeries.map((p) => p.timestamp)).size,
    avgDailyCost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    models: [],
    topModel: null,
  };
  const byKey = new Map<string, CostModelRow>();
  for (const point of costSeries) {
    const key = modelKey(point.model, point.provider);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        model: point.model,
        provider: point.provider,
        cost: 0,
        requests: 0,
        unpricedRequests: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        share: 0,
      };
      byKey.set(key, row);
    }
    addCostPoint(row, point);
    addCostPoint(summary, point);
    row.cost += point.cost;
    summary.totalCost += point.cost;
  }

  summary.avgDailyCost = summary.activeDays > 0 ? summary.totalCost / summary.activeDays : 0;
  summary.models = [...byKey.values()].sort(
    (a, b) => b.cost - a.cost || b.requests - a.requests || a.key.localeCompare(b.key),
  );
  for (const row of summary.models) row.share = summary.totalCost > 0 ? row.cost / summary.totalCost : 0;
  const top = summary.models[0];
  summary.topModel = top !== undefined && top.cost > 0 ? top : null;
  return summary;
}

function addCostPoint(
  target: CostComponents & { requests: number; unpricedRequests: number },
  point: CostTimeSeriesPoint,
): void {
  target.costInput += point.costInput;
  target.costOutput += point.costOutput;
  target.costCacheRead += point.costCacheRead;
  target.costCacheWrite += point.costCacheWrite;
  target.requests += point.requests;
  target.unpricedRequests += point.unpricedRequests;
}

export function buildModelPerformanceLookup(
  points: readonly ModelPerformancePoint[],
): Map<string, ModelPerformanceDataPoint[]> {
  const byKey = new Map<string, ModelPerformanceDataPoint[]>();
  for (const point of points) {
    const key = modelKey(point.model, point.provider);
    let series = byKey.get(key);
    if (!series) {
      series = [];
      byKey.set(key, series);
    }
    series.push({
      timestamp: point.timestamp,
      avgTtftSeconds: point.avgTtft !== null ? point.avgTtft / 1000 : null,
      avgTokensPerSecond: point.avgTokensPerSecond,
      requests: point.requests,
    });
  }
  for (const series of byKey.values()) series.sort((a, b) => a.timestamp - b.timestamp);
  return byKey;
}

const TEMP_FOLDER_RE = /^\/?-?(?:private-)?(?:tmp|var-folders)(?:[-/]|$)/;

export function buildFolderRows(folders: readonly FolderStats[]): FolderTableView {
  let totalRequests = 0;
  let failedRequests = 0;
  let totalCost = 0;
  let unpricedRequests = 0;
  let conversationTokens = 0;
  let input = 0;
  let cacheRead = 0;
  let maxRequests = 0;
  let maxCost = 0;
  for (const f of folders) {
    totalRequests += f.totalRequests;
    failedRequests += f.failedRequests;
    totalCost += f.totalCost;
    unpricedRequests += f.unpricedRequests;
    conversationTokens += f.totalInputTokens + f.totalCacheReadTokens + f.totalCacheWriteTokens + f.totalOutputTokens;
    input += f.totalInputTokens;
    cacheRead += f.totalCacheReadTokens;
    if (f.totalRequests > maxRequests) maxRequests = f.totalRequests;
    if (f.totalCost > maxCost) maxCost = f.totalCost;
  }

  let temporaryCount = 0;
  const rows = folders.map((f) => {
    const temporary = TEMP_FOLDER_RE.test(f.folder);
    if (temporary) temporaryCount++;
    return {
      ...f,
      conversationTokens:
        f.totalInputTokens + f.totalCacheReadTokens + f.totalCacheWriteTokens + f.totalOutputTokens,
      requestShare: totalRequests > 0 ? f.totalRequests / totalRequests : 0,
      costShare: totalCost > 0 ? f.totalCost / totalCost : 0,
      temporary,
    };
  });

  return {
    rows,
    totalRequests,
    failedRequests,
    totalCost,
    unpricedRequests,
    conversationTokens,
    cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0,
    maxRequests,
    maxCost,
    temporaryCount,
  };
}

export interface ToolRowView extends ToolUsageStats {
  errorRate: number;
  callFraction: number;
  tokenFraction: number;
  costFraction: number;
  avgResultChars: number;
}

export function buildToolRows(tools: ToolUsageStats[]): ToolRowView[] {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  for (const t of tools) {
    calls += t.calls;
    tokens += t.totalTokensShare;
    cost += t.costShare;
  }
  return tools.map((t) => ({
    ...t,
    errorRate: t.calls > 0 ? t.errors / t.calls : 0,
    callFraction: calls > 0 ? t.calls / calls : 0,
    tokenFraction: tokens > 0 ? t.totalTokensShare / tokens : 0,
    costFraction: cost > 0 ? t.costShare / cost : 0,
    avgResultChars: t.calls > 0 ? t.resultChars / t.calls : 0,
  }));
}

export type RequestStatus = "ok" | "aborted" | "failed";

export function requestStatus(row: Pick<MessageStats, "stopReason" | "errorMessage">): RequestStatus {
  if (row.stopReason === "aborted") return "aborted";
  if (row.stopReason === "error" || row.errorMessage) return "failed";
  return "ok";
}

export interface RequestLogSummary {
  requests: number;
  failed: number;
  aborted: number;
  tokens: number;
  cost: number;
  unpriced: number;
  medianDuration: number | null;
  p95Duration: number | null;
  medianTtft: number | null;
  oldest: number | null;
  newest: number | null;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function summarizeRequests(rows: readonly MessageStats[]): RequestLogSummary {
  let failed = 0;
  let aborted = 0;
  let tokens = 0;
  let cost = 0;
  let unpriced = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const durations: number[] = [];
  const ttfts: number[] = [];
  for (const row of rows) {
    const status = requestStatus(row);
    if (status === "failed") failed++;
    else if (status === "aborted") aborted++;
    tokens += row.usage.totalTokens;
    cost += row.usage.cost.total;
    if (isUnpricedMessage(row)) unpriced++;
    if (row.duration !== null) durations.push(row.duration);
    if (row.ttft !== null) ttfts.push(row.ttft);
    if (oldest === null || row.timestamp < oldest) oldest = row.timestamp;
    if (newest === null || row.timestamp > newest) newest = row.timestamp;
  }
  durations.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);
  return {
    requests: rows.length,
    failed,
    aborted,
    tokens,
    cost,
    unpriced,
    medianDuration: quantile(durations, 0.5),
    p95Duration: quantile(durations, 0.95),
    medianTtft: quantile(ttfts, 0.5),
    oldest,
    newest,
  };
}

const SIGNATURE_MAX = 180;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID_RE = /\b(?:req|msg|call|toolu|chatcmpl|resp|run|gen)[-_][A-Za-z0-9_-]{6,}/g;
const HEX_RE = /\b[0-9a-f]{12,}\b/gi;
const NUMBER_RE = /(?<![\w.-])\d+(?:\.\d+)?/g;
const HTTP_STATUS_RE = /^[1-5]\d\d$/;

export function errorSignature(message: string | null): string {
  if (!message?.trim()) return t("settingsPage.stats.charts.unknownError");
  const normalized = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(UUID_RE, "<id>")
    .replace(PREFIXED_ID_RE, "<id>")
    .replace(HEX_RE, "<hex>")
    .replace(NUMBER_RE, (n) => (HTTP_STATUS_RE.test(n) ? n : "N"));
  return normalized.length > SIGNATURE_MAX ? `${normalized.slice(0, SIGNATURE_MAX - 1)}…` : normalized;
}

export interface ErrorGroupModel {
  model: string;
  provider: string;
  count: number;
}

export interface ErrorGroupView {
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  latest: MessageStats;
  models: ErrorGroupModel[];
}

export function groupErrorsBySignature(rows: readonly MessageStats[]): ErrorGroupView[] {
  const groups = new Map<string, ErrorGroupView & { byModel: Map<string, ErrorGroupModel> }>();
  for (const row of rows) {
    const signature = errorSignature(row.errorMessage);
    let group = groups.get(signature);
    if (!group) {
      group = {
        signature,
        count: 0,
        firstSeen: row.timestamp,
        lastSeen: row.timestamp,
        latest: row,
        models: [],
        byModel: new Map(),
      };
      groups.set(signature, group);
    }
    group.count++;
    if (row.timestamp < group.firstSeen) group.firstSeen = row.timestamp;
    if (row.timestamp > group.lastSeen) {
      group.lastSeen = row.timestamp;
      group.latest = row;
    }
    const key = modelKey(row.model, row.provider);
    const model = group.byModel.get(key);
    if (model) model.count++;
    else group.byModel.set(key, { model: row.model, provider: row.provider, count: 1 });
  }
  return [...groups.values()]
    .map(({ byModel, ...group }) => ({
      ...group,
      models: [...byModel.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}
