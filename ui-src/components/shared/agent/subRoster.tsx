// Subagent roster: row projection + roster rows + the header/usage summary, shared by the
// middle-card Agent Hub and the right-sidebar subagent tab (one component, two surfaces).
// Only the surrounding chrome differs: the hub adds its keybind bar and back button, and
// passes onOpen so a row opens the sidebar detail instead of the hub's session jump.
import { useEffect, useMemo, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, openSessionByPath } from "../../../store";
import { expandRightPanel } from "../../main/right/tabs";
import { modelShort, tokenTotal, usageSegments, clockHMS, stInfo, stKeyOf, stLabel, subStatus, currentProgress, type SegT } from "./subShared";
import type { SubagentState } from "../../../types/session";

// The subset of the open-session snapshot the roster reads; both surfaces pass the live
// session object, whose extra fields stay invisible to the roster.
export type RosterSession = { sessionId: string; subagents: Map<string, SubagentState> };

/** Switch the middle column to a subagent: its own session when the child persisted one,
 * otherwise the sidebar detail. Shared by the Agent Hub Enter key, the roster row's
 * double-click and its open button; leaving the hub first keeps the surfaces consistent. */
export function openSubagentSession(id: string, sub: SubagentState | undefined): void {
  const st = useAppStore.getState();
  st.closeHub();
  if (sub?.sessionFile) openSessionByPath(sub.sessionFile);
  else expandRightPanel("subagent", { selectedSubagent: id });
}

type SubEntry = [string, SubagentState];
export type Row = { id: string; sub: SubagentState };

// Relative age (seconds bucketed like the TUI's formatAge): the hub-page card's "active N
// ago" under the elapsed clock.
function ageText(sec: number, t: SegT): string {
  if (sec < 5) return t("right.closedNow");
  if (sec < 3600) return t("right.closedMin", { n: Math.floor(sec / 60) || 1 });
  if (sec < 86400) return t("right.closedHour", { n: Math.floor(sec / 3600) });
  return t("right.closedDay", { n: Math.floor(sec / 86400) });
}

// Humanized duration for the page card's time row (age + "ran for" duration):
// largest units first, zero units dropped, seconds always present.
function durText(ms: number, t: SegT): string {
  const s = Math.round(ms / 1000);
  if (s <= 0) return "—";
  const parts: string[] = [];
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) parts.push(t("right.hubDurDay", { n: d }));
  if (h) parts.push(t("right.hubDurHour", { n: h }));
  if (m) parts.push(t("right.hubDurMin", { n: m }));
  if (s % 60 || !parts.length) parts.push(t("right.hubDurSec", { n: s % 60 }));
  return parts.join(" ");
}

// Project the subagent map into display rows: status order first (running → completed →
// failed → aborted → unknown), registration order within one status. `status` is the status
// tab's selection: "all", or a display-group key (unknown tokens group under themselves).
export function buildRows(subs: SubEntry[], status = "all"): Row[] {
  return [...subs]
    .sort((a, b) => stInfo(subStatus(a[1])).order - stInfo(subStatus(b[1])).order) // stable sort keeps registration (Map insertion) order within one status
    .filter(([, sub]) => status === "all" || stKeyOf(subStatus(sub)) === status)
    .map(([id, sub]) => ({ id, sub }));
}

// Tree indentation depth: a child's parent is referenced by id or by display name (the base
// emits either), so resolve through both. Cycles are cut by the seen set — a malformed
// parent chain degrades to a flat row instead of looping.
export function treeDepth(rows: Row[], row: Row): number {
  const byIdOrName = new Map<string, Row>();
  for (const r of rows) {
    byIdOrName.set(r.id, r);
    if (r.sub.name) byIdOrName.set(r.sub.name, r);
  }
  let depth = 0;
  const seen = new Set<string>([row.id]);
  let parent = row.sub.parent;
  while (parent && parent !== "main" && !seen.has(parent)) {
    const p = byIdOrName.get(parent);
    if (!p) break;
    seen.add(parent);
    depth += 1;
    parent = p.sub.parent;
  }
  return depth;
}

// Live elapsed / age repaint once per second while any visible subagent streams: host
// durationMs only arrives throttled at 500ms boundaries (same pattern as SessionStatsBar)
export function useRosterTick(s: RosterSession | undefined) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const anyStreaming = !!s && [...s.subagents.values()].some((x) => x.streaming);
  useEffect(() => {
    if (!anyStreaming) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [anyStreaming]);
}

// The subagents Map mutates in place (its reference never changes), so the rows memo keys on
// a membership+status signature instead of the session object (6b): unrelated session writes
// (item pushes, draft flushes) no longer rebuild the roster. Value updates still flow: HubRow
// reads the same sub objects the map holds.
export function useRosterRows(s: RosterSession | undefined): Row[] {
  const status = useAppStore((st) => st.hubStatus);
  const sig = s ? [...s.subagents].map(([id, x]) => `${id}:${x.status}:${x.streaming ? 1 : 0}:${x.name ?? ""}`).join(";") : "";
  return useMemo(() => (s ? buildRows([...s.subagents], status) : []), [sig, status]);
}

// Same signature trick as useRosterRows: the subagents Map mutates in place, so keying these
// aggregates on [s] rebuilt them on every unrelated session write (delta frames arrive at
// ~10Hz). Streams: subStatus depends on `streaming`, hence it is in the key.
function usageSignature(s: RosterSession): string {
  return [...s.subagents]
    .map(
      ([id, x]) =>
        `${id}:${x.streaming ? 1 : 0}:${x.status}:${x.usage?.cost ?? ""}:${x.usage?.durationMs ?? ""}:${x.usage?.requests ?? ""}:${x.usage?.toolCount ?? x.tools.length}:${tokenTotal(x.usage?.tokens) ?? ""}`,
    )
    .join(";");
}

// Status filter pills, the automations list's capsule row. Five slots, always present, so the
// bar never reflows as subagents come and go; unknown statuses count only under "all".
export function StatusTabs({ s }: { s: RosterSession }) {
  const { t } = useTranslation();
  const hubStatus = useAppStore((st) => st.hubStatus);
  const sig = usageSignature(s);
  const tabs = useMemo(() => {
    const c = new Map<string, number>();
    for (const [, sub] of s.subagents) {
      const key = stKeyOf(subStatus(sub));
      c.set(key, (c.get(key) ?? 0) + 1);
    }
    const groups = ["running", "completed", "failed", "aborted"] as const;
    return [["all", s.subagents.size] as const, ...groups.map((k) => [k, c.get(k) ?? 0] as const)];
  }, [sig]);
  return (
    <div className="al-filters hub-tabs">
      {tabs.map(([key, n]) => (
        <button
          key={key}
          type="button"
          className={"al-pill" + (key === hubStatus ? " on" : "")}
          aria-pressed={key === hubStatus}
          onClick={() => useAppStore.getState().setHubStatus(key)}
        >
          {key === "all" ? t("right.hubStatusAll") : stLabel(key, t)}
          <span className="al-pill-n">{n}</span>
        </button>
      ))}
    </div>
  );
}

// Aggregate usage over every measured subagent. The Hub page uses a compact summary; the sidebar keeps labeled cells.
export function HubUsage({ s, compact = false }: { s: RosterSession; compact?: boolean }) {
  const { t } = useTranslation();
  const sig = usageSignature(s);
  const agg = useMemo(() => {
    let cost = 0, dur = 0, reqs = 0, tools = 0, tok = 0, measured = 0;
    for (const [, sub] of s.subagents) {
      const u = sub.usage;
      if (!u) continue;
      measured++;
      cost += u.cost ?? 0;
      dur += u.durationMs ?? 0;
      reqs += u.requests ?? 0;
      tools += u.toolCount ?? sub.tools.length;
      tok += tokenTotal(u.tokens) ?? 0;
    }
    return { cost, dur, reqs, tools, tok, measured };
  }, [sig]);
  if (compact) {
    return (
      <div className="hub-usage hub-usage-compact text-faint">
        {agg.measured === 0
          ? t("right.hubNoUsage")
          : [
              `$${agg.cost.toFixed(3)}`,
              agg.dur > 0 ? clockHMS(agg.dur) : "—",
              t("right.subRequests", { n: agg.reqs }),
              t("right.subTools", { n: agg.tools }),
              `${fmtTokens(agg.tok)} tok`,
            ].join(" · ")}
      </div>
    );
  }
  // Throughput matches the deck pulse: aggregate tokens per second of agent time.
  const rate = agg.dur > 0 ? agg.tok / (agg.dur / 1000) : 0;
  const cells: Array<[string, string]> = [
    [t("right.hubStatTokens"), fmtTokens(agg.tok)],
    [t("right.hubStatCost"), `$${agg.cost.toFixed(3)}`],
    [t("right.hubStatTools"), String(agg.tools)],
    [t("right.hubStatRate"), rate > 0 ? `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} t/s` : "—"],
    [t("right.hubStatClock"), agg.dur > 0 ? clockHMS(agg.dur) : "—"],
  ];
  return (
    <div className="hub-usage text-faint">
      {agg.measured === 0 ? (
        t("right.hubNoUsage")
      ) : (
        cells.map(([label, value], i) => (
          <div className="hub-stat" key={label}>
            <dt className="hub-stat-k">{label}</dt>
            <dd className={"hub-stat-v" + (i === 1 ? " hub-cost" : "")}>{value}</dd>
          </div>
        ))
      )}
    </div>
  );
}


export function HubRow({ row, selected, onSelect, onOpen, t, minimal }: { row: Row; selected: boolean; onSelect: () => void; onOpen?: () => void; t: SegT; minimal?: boolean }) {
  const { sub } = row;
  const segs = usageSegments(sub, t, { model: false });
  // Role alias (TASK/SMOL) rides left of the model id, " · "-joined; absent for concrete-model runs
  const role = sub.usage?.modelRole?.toUpperCase();
  // The base hands the level either as a `<model>:<level>` suffix (modelShort translates it) or
  // as resolvedThinkingLevel; both land as the same second run, separated by one space.
  const short = modelShort(sub.usage?.resolvedModel);
  const cut = short.lastIndexOf(":");
  const model = cut > 0 ? short.slice(0, cut) : short;
  const thinkRaw = sub.usage?.resolvedThinkingLevel ?? (cut > 0 ? short.slice(cut + 1) : "");
  const think = thinkRaw ? t(`composer.thinkingLevels.${thinkRaw}`, { defaultValue: thinkRaw }) : "";
  const st = subStatus(sub);
  const group = stInfo(st).group;
  const elapsed = sub.streaming && sub.registeredAt ? Date.now() - sub.registeredAt : (sub.usage?.durationMs ?? 0);
  // Fallback transcript is capped; mark the cut so the row is not read as the whole task
  const rawTask = sub.description || sub.task || sub.text || "";
  const rowTask = rawTask.length > 80 ? rawTask.slice(0, 80) + "…" : rawTask || "…";
  return (
    <div
      role="option"
      aria-selected={selected}
      className={"hub-row" + (selected ? " on" : "")}
      onClick={onSelect}
      onDoubleClick={() => {
        // Sidebar tab: both clicks land on the same inspector (onOpen), so nothing to do
        if (onOpen) return onOpen();
        openSubagentSession(row.id, sub);
      }}
    >
      {/* Top block: avatar | name / model | status / elapsed */}
      <div className="hub-top">
        <span className="hub-avatar" aria-hidden="true">{(sub.name ?? sub.agent).trim()[0]?.toUpperCase() ?? "?"}</span>
        <span className="hub-row-head">
          <span className="hub-name">{sub.name ?? sub.agent}</span>
          {role || model || think ? (
            <span className="hub-model">
              {role ? <span className="hub-role">{role}</span> : null}
              {role && (model || think) ? <span className="hub-sep"> · </span> : null}
              {model || think ? (
                <span className="hub-mdl">
                  {model}
                  {model && think ? " " : null}
                  {think ? <span className="hub-think">{think}</span> : null}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="hub-side">
          <span className="ad-status" data-tone={group}>
            <i aria-hidden="true" />
          </span>
          <span className="hub-clock">{elapsed > 0 ? clockHMS(elapsed) : "—"}</span>
        </span>
      </div>
      {/* Running rows show the live progress line ("Current" in the detail) instead of the
          static assignment; it falls back to the assignment until the first tool/intent lands.
          The completion probe's self-estimate leads the line while the child runs (the probe
          stops at terminal status, and a yield pins it to 99). Minimal density keeps only the
          top block. */}
      {!minimal ? (
        <span className="hub-task text-faint" title={rawTask || undefined}>
          {sub.streaming && sub.usage?.completionPercent !== undefined ? (
            <span className="hub-pct">{sub.usage.completionPercent}%</span>
          ) : null}
          {sub.streaming ? currentProgress(sub) || rowTask : rowTask}
        </span>
      ) : null}
      {/* Bottom block: the usage stats, " · "-joined as one line (tokens · cost · requests · tools). */}
      {!minimal && segs.length ? (
        <div className="hub-meta text-faint">{segs.join(" · ")}</div>
      ) : null}
    </div>
  );
}

/** Agent Hub page card (the full-page roster only; the sidebar keeps HubRow): the flat-card
    layout ported from omp-studio's Agent Hub — left zone status/title over task over model,
    right zone elapsed+age, big tokens, req/tools, cost. */
export function HubPageCard({ row, selected, onSelect, minimal, t }: { row: Row; selected: boolean; onSelect: () => void; minimal?: boolean; t: SegT }) {
  const { sub } = row;
  const u = sub.usage;
  const st = subStatus(sub);
  const group = stInfo(st).group;
  const name = sub.name ?? sub.agent;
  const role = u?.modelRole?.toUpperCase();
  const short = modelShort(u?.resolvedModel);
  const cut = short.lastIndexOf(":");
  const model = cut > 0 ? short.slice(0, cut) : short;
  const thinkRaw = u?.resolvedThinkingLevel ?? (cut > 0 ? short.slice(cut + 1) : "");
  const think = thinkRaw ? t(`composer.thinkingLevels.${thinkRaw}`, { defaultValue: thinkRaw }) : "";
  const tokens = tokenTotal(u?.tokens);
  const elapsed = sub.streaming && sub.registeredAt ? Date.now() - sub.registeredAt : (u?.durationMs ?? 0);
  const age = ageText(Math.max(1, Math.round((Date.now() - ((sub.registeredAt ?? Date.now()) + (u?.durationMs ?? 0))) / 1000)), t);
  const rawTask = sub.description || sub.task || sub.text || "";
  const task = sub.streaming ? currentProgress(sub) || rawTask : rawTask;
  return (
    <div
      role="option"
      aria-selected={selected}
      className={"hub-card" + (selected ? " selected" : "")}
      onClick={onSelect}
      onDoubleClick={() => openSubagentSession(row.id, sub)}
    >
      <div className="hc-top">
        <i className="ad-dot" data-tone={group} aria-hidden="true" />
        <span className="hc-name">
          <span className="hc-title">{name}</span>
        </span>
      </div>
      <span className="hc-tokens">
        <b>{tokens === undefined ? "—" : fmtTokens(tokens)}</b>
        <i>tok</i>
      </span>
      {/* Minimal density keeps only the identity row; the right column stays (it is the
          card's metrics, the reason the page card exists). */}
      {!minimal ? (
        <div className="hc-task" title={task || undefined}>
          {sub.streaming && u?.completionPercent !== undefined ? <span className="hub-pct">{u.completionPercent}%</span> : null}
          {task || "…"}
        </div>
      ) : null}
      <span className="hc-cost">{u && u.cost != null && u.cost > 0 ? `$${u.cost.toFixed(3)}` : "—"}</span>
      <span className="hc-pace">
        <span className="hc-num"><i>{t("right.hubReq")}</i><b>{u?.requests ?? 0}</b></span>
        <span className="hc-num"><i>{t("right.hubTools")}</i><b>{u?.toolCount ?? sub.tools.length}</b></span>
      </span>
      <span className="hc-time">{age} {t("right.hubRanFor")} {elapsed > 0 ? durText(elapsed, t) : "—"}</span>
      <div className="hc-foot">
        {role ? <span className="hc-chip">{role}</span> : null}
        {model || think ? (
          <span className="hc-model" title={u?.resolvedModel ?? undefined}>
            {model}
            {model && think ? " " : null}
            {think ? <span className="hub-think">{think}</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
