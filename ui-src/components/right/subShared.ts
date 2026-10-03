// Shared subagent formatting helpers: the right-sidebar subagent page, the middle-card
// Agent Hub roster and the hub's linked detail page all render the same metrics
// (model/tokens/cost/requests/tools/start/elapsed) from SubagentState.usage.
import { useAppStore, fmtTokens, fmtDurationMs } from "../../store";
import type { SubagentState } from "../../types/session";

// Model display name: look up modelNames; without an entry take the id tail (same rule as the composer bar)
export function modelShort(id: string | null | undefined): string {
  if (!id) return "";
  return useAppStore.getState().modelNames.get(id) ?? id.split("/").pop() ?? "";
}

// Token total from the SDK bucket object: prefer the explicit total, otherwise sum the buckets
export function tokenTotal(tokens: Record<string, number> | undefined): number | undefined {
  if (!tokens) return undefined;
  if (typeof tokens.total === "number") return tokens.total;
  const sum = Object.values(tokens).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  return sum || undefined;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function fmtClock(ts: number | undefined): string {
  return ts ? clockFmt.format(new Date(ts)) : "—";
}

export type SegT = (k: string, o?: Record<string, unknown>) => string;

// Stats segments shared by the list card, the hub roster and the detail header.
// While streaming the elapsed figure is extrapolated from registeredAt (host durationMs lags).
// opts.model=false drops the model segment (the hub card already shows the model badge in
// the head row, so repeating it in the metrics line is redundant).
export function usageSegments(sub: SubagentState, t: SegT, opts?: { model?: boolean }): string[] {
  const u = sub.usage;
  const segs: string[] = [];
  if (opts?.model !== false) {
    const model = modelShort(u?.resolvedModel);
    if (model) segs.push(model);
  }
  const tokens = tokenTotal(u?.tokens);
  if (tokens !== undefined) segs.push(`${fmtTokens(tokens)} tok`);
  if (u && u.cost != null && u.cost > 0) segs.push(`$${u.cost.toFixed(4)}`);
  const reqs = u?.requests ?? 0;
  if (reqs > 0) segs.push(t("right.subRequests", { n: reqs }));
  const toolN = u?.toolCount ?? sub.tools.length;
  if (toolN > 0) segs.push(t("right.subTools", { n: toolN }));
  return segs;
}

export function timeSegments(sub: SubagentState, t: SegT, now: number): string[] {
  const segs: string[] = [];
  if (sub.registeredAt) segs.push(t("right.subStarted", { time: fmtClock(sub.registeredAt) }));
  const elapsed =
    sub.streaming && sub.registeredAt ? now - sub.registeredAt : (sub.usage?.durationMs ?? 0);
  if (elapsed > 0) segs.push(t("right.subElapsed", { duration: fmtDurationMs(elapsed) }));
  return segs;
}

// Roster status ordering (running first), matching the TUI Agent Hub's STATUS_ORDER
export const STATUS_ORDER: Record<string, number> = { started: 0, running: 0, completed: 1, failed: 2, aborted: 3 };
export function subStatus(sub: SubagentState): string {
  return sub.streaming ? "running" : sub.status;
}
