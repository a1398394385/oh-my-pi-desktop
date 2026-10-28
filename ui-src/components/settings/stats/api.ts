import { t } from "../../../i18n";
import type {
  AcpCompactionRow,
  CostDashboardStats,
  FolderStats,
  FrustrationDashboardStats,
  FrustrationEstimate,
  FrustrationJobStatus,
  GainDashboardStats,
  LiveStatus,
  MessageStats,
  ModelDashboardStats,
  OverviewStats,
  ProviderDashboardStats,
  ProviderWindowStats,
  RequestDetails,
  SessionSummary,
  SessionTrace,
  TimeRange,
  ToolDashboardStats,
} from "./types";
import { useAppStore } from "../../../store";

export function getApiBase(): string {
  const ws = useAppStore.getState().ws;
  if (ws && ws.url) {
    // The WS url may carry a trailing "/" (e.g. Bun-normalized "ws://host:port/");
    // fetch paths below are absolute ("/api/..."), so a bare swap would double it.
    return ws.url.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://").replace(/\/+$/, "");
  }
  return "";
}

export class ApiError extends Error {
  status: number;
  endpoint: string;

  constructor(status: number, endpoint: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Prefer the server's { error } body over a bare status line. */
async function readErrorMessage(res: Response, endpoint: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Non-JSON error body: fall through to the status line.
  }
  return t("settingsPage.stats.api.httpError", { status: res.status, endpoint });
}

/**
 * ETag + parsed body per endpoint. The stats server only tags session traces,
 * and a 304 lets the polling trace view reuse the body it already holds
 * instead of downloading megabytes again.
 */
const revalidations = new Map<string, { etag: string; body: unknown }>();
const REVALIDATION_LIMIT = 8;

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getApiBase();
  const endpoint = `${base}${path}`;
  const method = options?.method ?? "GET";
  const cached = method === "GET" ? revalidations.get(path) : undefined;
  let init = options;
  if (cached) {
    const headers = new Headers(options?.headers);
    headers.set("If-None-Match", cached.etag);
    init = { ...options, headers };
  }
  const res = await fetch(endpoint, init);
  if (res.status === 304 && cached) return cached.body as T;
  if (!res.ok) {
    throw new ApiError(res.status, endpoint, await readErrorMessage(res, endpoint));
  }
  const data = (await res.json()) as T;
  if (method === "GET") {
    revalidations.delete(path);
    const etag = res.headers.get("ETag");
    if (etag) {
      revalidations.set(path, { etag, body: data });
      while (revalidations.size > REVALIDATION_LIMIT) {
        const oldest = revalidations.keys().next().value;
        if (oldest === undefined) break;
        revalidations.delete(oldest);
      }
    }
  }
  return data;
}

const ACTION_HEADERS = { "X-Omp-Stats-Action": "1" };

export async function getOverviewStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<OverviewStats> {
  return fetchJson<OverviewStats>(`/api/stats/overview?range=${encodeURIComponent(range)}`, {
    signal,
  });
}

export async function getModelDashboardStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<ModelDashboardStats> {
  return fetchJson<ModelDashboardStats>(`/api/stats/model-dashboard?range=${encodeURIComponent(range)}`, {
    signal,
  });
}

export async function getCostDashboardStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<CostDashboardStats> {
  return fetchJson<CostDashboardStats>(`/api/stats/costs?range=${encodeURIComponent(range)}`, { signal });
}

export async function getRecentRequests(limit = 50, signal?: AbortSignal): Promise<MessageStats[]> {
  return fetchJson<MessageStats[]>(`/api/stats/recent?limit=${limit}`, { signal });
}

export async function getRecentErrors(
  range: TimeRange = "24h",
  limit = 50,
  signal?: AbortSignal,
): Promise<MessageStats[]> {
  return fetchJson<MessageStats[]>(`/api/stats/errors?range=${encodeURIComponent(range)}&limit=${limit}`, {
    signal,
  });
}

export async function getRequestDetails(id: number, signal?: AbortSignal): Promise<RequestDetails> {
  return fetchJson<RequestDetails>(`/api/request/${id}`, { signal });
}

/** Ask the server to start a background sync; progress arrives on the /api/events stream. */
export async function requestSync(): Promise<LiveStatus> {
  return fetchJson<LiveStatus>("/api/sync", { method: "POST" });
}

export async function getFrustrationDashboardStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<FrustrationDashboardStats> {
  return fetchJson<FrustrationDashboardStats>(`/api/stats/frustration?range=${encodeURIComponent(range)}`, {
    signal,
  });
}

/** Pre-run cost quote for judging every unjudged message in range. */
export async function getFrustrationEstimate(range: TimeRange, signal?: AbortSignal): Promise<FrustrationEstimate> {
  return fetchJson<FrustrationEstimate>(`/api/frustration/estimate?range=${encodeURIComponent(range)}`, {
    signal,
  });
}

/** Start the judge run over the unjudged messages in range. Spends money. */
export async function startFrustrationRun(range: TimeRange): Promise<FrustrationJobStatus> {
  return fetchJson<FrustrationJobStatus>(`/api/frustration/judge?range=${encodeURIComponent(range)}`, {
    method: "POST",
    headers: ACTION_HEADERS,
  });
}

export async function cancelFrustrationRun(): Promise<FrustrationJobStatus> {
  return fetchJson<FrustrationJobStatus>("/api/frustration/cancel", {
    method: "POST",
    headers: ACTION_HEADERS,
  });
}

export async function getFolderStats(range: TimeRange = "24h", signal?: AbortSignal): Promise<FolderStats[]> {
  return fetchJson<FolderStats[]>(`/api/stats/folders?range=${encodeURIComponent(range)}`, { signal });
}

export async function getGainDashboardStats(
  range: TimeRange = "24h",
  project?: string | null,
  signal?: AbortSignal,
): Promise<GainDashboardStats> {
  const params = new URLSearchParams({ range });
  if (project) params.set("project", project);
  return fetchJson<GainDashboardStats>(`/api/stats/gain?${params}`, { signal });
}

export async function getToolDashboardStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<ToolDashboardStats> {
  return fetchJson<ToolDashboardStats>(`/api/stats/tools?range=${encodeURIComponent(range)}`, { signal });
}

/** Per-compression ACP rows (host-owned endpoint; the base server has no ACP data). */
export async function getAcpCompactionStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<AcpCompactionRow[]> {
  return fetchJson<AcpCompactionRow[]>(`/api/stats/acp?range=${encodeURIComponent(range)}`, { signal });
}

export async function getProviderDashboardStats(
  range: TimeRange = "24h",
  signal?: AbortSignal,
): Promise<ProviderDashboardStats> {
  return fetchJson<ProviderDashboardStats>(`/api/stats/providers?range=${encodeURIComponent(range)}`, {
    signal,
  });
}

/** Subscription-window insights (all providers) plus utilization series for provider only. */
export async function getProviderWindowStats(
  range: TimeRange,
  provider: string | null,
  signal?: AbortSignal,
): Promise<ProviderWindowStats> {
  const params = new URLSearchParams({ range });
  if (provider !== null) params.set("provider", provider);
  return fetchJson<ProviderWindowStats>(`/api/stats/provider-windows?${params}`, { signal });
}

export async function getSessions(limit = 100, q?: string, signal?: AbortSignal): Promise<SessionSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("q", q);
  return fetchJson<SessionSummary[]>(`/api/sessions?${params}`, { signal });
}

export async function getSessionTrace(file: string, signal?: AbortSignal): Promise<SessionTrace> {
  return fetchJson<SessionTrace>(`/api/session/trace?file=${encodeURIComponent(file)}`, { signal });
}

/** Fetch one full journal entry for the span drawer. Entries are opaque JSON. */
export async function getSessionEntryDetail(
  file: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ entry: unknown }> {
  return fetchJson<{ entry: unknown }>(
    `/api/session/entry?file=${encodeURIComponent(file)}&id=${encodeURIComponent(id)}`,
    { signal },
  );
}
