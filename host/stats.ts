// 使用统计：扫描全部会话文件聚合 token/时长/模型分布与连续活跃天数。
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
