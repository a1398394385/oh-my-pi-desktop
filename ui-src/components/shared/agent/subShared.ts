// Shared subagent formatting helpers: the right-sidebar subagent page, the middle-card
// Agent Hub roster and the hub's linked detail page all render the same metrics
// (model/tokens/cost/requests/tools/start/elapsed) from SubagentState.usage.
import { useAppStore, fmtTokens, fmtDurationMs } from "../../../store";
import { localeDate } from "../../../lib/locale";
import { t } from "../../../i18n";
import type { SubagentState } from "../../../types/session";

// Model display name: look up modelNames; without an entry take the id tail (same rule as the
// composer bar). The base appends the resolved thinking level as a `:<level>` suffix (only when
// one was resolved), so that tail goes through composer.thinkingLevels — an unknown level falls
// back to its raw text.
export function modelShort(id: string | null | undefined): string {
  if (!id) return "";
  const name = useAppStore.getState().modelNames.get(id) ?? id.split("/").pop() ?? "";
  const cut = name.lastIndexOf(":");
  if (cut <= 0) return name;
  const level = name.slice(cut + 1);
  return `${name.slice(0, cut)}:${t(`composer.thinkingLevels.${level}`, { defaultValue: level })}`;
}

// Token total from the SDK bucket object: prefer the explicit total, otherwise sum the buckets
export function tokenTotal(tokens: Record<string, number> | undefined): number | undefined {
  if (!tokens) return undefined;
  if (typeof tokens.total === "number") return tokens.total;
  const sum = Object.values(tokens).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  return sum || undefined;
}

const clockFmt = localeDate({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export function fmtClock(ts: number | undefined): string {
  return ts ? clockFmt(ts) : "—";
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

// Live progress line: the running tool's intent, else its raw args, else the model's last
// stated intent. Shared by the detail's "Current" section and a running roster row's task slot.
// Intent first: the args dump is a JSON blob that gets cut off in both places.
export function currentProgress(sub: SubagentState): string {
  const u = sub.usage;
  if (u?.currentToolIntent) return u.currentToolIntent;
  if (u?.currentTool) return u.currentTool + (u.currentToolArgs ? ` · ${JSON.stringify(u.currentToolArgs)}` : "");
  return u?.lastIntent ?? "";
}

// Statuses the base emits, in two vocabularies: lifecycle frames (started|completed|failed|
// aborted) and progress frames (pending|running|completed|failed|aborted).
export type SubStatus = "started" | "pending" | "running" | "completed" | "failed" | "aborted";

// Display groups shared by the roster pills, the header counts and the hub detail head.
// "unknown" is a status neither vocabulary knows (a newer base state) and must never pose
// as running.
export type StGroup = "running" | "completed" | "failed" | "aborted" | "unknown";

// One row per status: roster sort weight (running first, as the TUI Agent Hub orders them) and
// display group. Every consumer reads this table, so the ordering and the pills cannot drift
// apart; a status added above without a row fails the build.
const ST_ROWS: Record<SubStatus, { order: number; group: StGroup }> = {
  started: { order: 0, group: "running" },
  pending: { order: 0, group: "running" },
  running: { order: 0, group: "running" },
  completed: { order: 1, group: "completed" },
  failed: { order: 2, group: "failed" },
  aborted: { order: 3, group: "aborted" },
};
// Widened for lookup by the raw frame status, which leaves SubStatus once the base adds a state.
const ST_TABLE: Record<string, { order: number; group: StGroup }> = ST_ROWS;
const ST_UNKNOWN = { order: 4, group: "unknown" as const };

export function subStatus(sub: SubagentState): string {
  return sub.streaming ? "running" : sub.status;
}

// Sort weight + display group for a status value. Unknown values get their own group and the
// tail order instead of being silently reported as running.
export function stInfo(status: string): { order: number; group: StGroup } {
  return ST_TABLE[status] ?? ST_UNKNOWN;
}

export const ST_KEY: Record<Exclude<StGroup, "unknown">, string> = {
  running: "right.subStRunning",
  completed: "right.subStCompleted",
  failed: "right.subStFailed",
  aborted: "right.subStAborted",
};

// Chip/pill key for a status: its display group, or the raw status token when the group is
// unknown (a state this build has no copy for, so the token is the honest label).
export function stKeyOf(status: string): string {
  const { group } = stInfo(status);
  return group === "unknown" ? status : group;
}

// Label for a stKeyOf/stInfo group key: the group copy, else the key itself.
export function stLabel(key: string, t: SegT): string {
  const copy = (ST_KEY as Record<string, string | undefined>)[key];
  return copy ? t(copy) : key;
}
