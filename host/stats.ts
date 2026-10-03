// Usage stats: scan all session files to aggregate tokens/duration/model distribution and consecutive active days.
import { readFile } from "node:fs/promises";
import { SessionManager } from "./bootstrap.ts";

export function streakFromDays(days: string[]): { current: number; longest: number } {
  const uniq = [...new Set(days)].sort();
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of uniq) {
    const t = Date.parse(d + "T00:00:00Z");
    if (prev != null && t - prev === 86400000) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    prev = t;
  }
  const today = new Date();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  let current = 0;
  for (let i = 0; i < 400; i++) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    if (uniq.includes(iso(dt))) current += 1;
    else break;
  }
  return { current, longest };
}

export async function collectUsageStats() {
  const all = await SessionManager.listAll();
  const byDay: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const heat: Record<string, number> = {};
  let totalTokens = 0;
  let peakTokens = 0;
  let longestMs = 0;
  const daySet: string[] = [];
  for (const s of all) {
    const day = s.modified.toISOString().slice(0, 10);
    daySet.push(day);
    heat[day] = (heat[day] ?? 0) + 1;
    try {
      const text = await readFile(s.path, "utf8");
      const lines = text.split("\n");
      let firstTs: number | null = null;
      let lastTs: number | null = null;
      let sessionTokens = 0;
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts)) {
          if (firstTs == null || ts < firstTs) firstTs = ts;
          if (lastTs == null || ts > lastTs) lastTs = ts;
        }
        const usage = obj.message?.usage ?? obj.usage;
        const tokens = Number(usage?.totalTokens ?? 0) || Number(usage?.input ?? 0) + Number(usage?.output ?? 0);
        if (tokens > 0) {
          sessionTokens += tokens;
          totalTokens += tokens;
          const model = obj.message?.model ?? obj.model ?? "unknown";
          byModel[model] = (byModel[model] ?? 0) + tokens;
          const d = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : day;
          byDay[d] = (byDay[d] ?? 0) + tokens;
        }
      }
      if (sessionTokens > peakTokens) peakTokens = sessionTokens;
      if (firstTs != null && lastTs != null && lastTs - firstTs > longestMs) longestMs = lastTs - firstTs;
    } catch {}
  }
  const streak = streakFromDays(daySet);
  return {
    totalTokens,
    peakTokens,
    longestMs,
    sessionCount: all.length,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    byDay,
    byModel,
    heat,
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Handle HTTP requests for stats dashboards (/api/* and /api/events).
 * Returns null if the request is not an API request.
 * `srv` is used to exempt the long-lived SSE stream from Bun's per-request
 * idle timeout (default ~10s kills an otherwise healthy event stream; the
 * official standalone dashboard does the same via server.timeout(req, 0)).
 */
export async function handleStatsHttp(req: Request, srv?: { timeout: (req: Request, seconds: number) => void }): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (url.pathname === "/api/events") {
    srv?.timeout(req, 0);
    const { statsLive } = await import("@oh-my-pi/omp-stats/live");
    const live = statsLive();
    live.start();
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (status: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(status)}\n\n`));
        };
        send(live.status());
        const unsubscribe = live.subscribe(send);
        const heartbeat = setInterval(
          () => controller.enqueue(encoder.encode(": keep-alive\n\n")),
          15_000,
        );
        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
        };
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  try {
    const { handleApi } = await import("@oh-my-pi/omp-stats/server");
    const res = await handleApi(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
  } catch (err: unknown) {
    return Response.json({ error: String(err) }, { status: 500, headers: CORS_HEADERS });
  }
}

