// Subagent roster: row projection + roster rows + the header/usage summary, shared by the
// middle-card Agent Hub and the right-sidebar subagent tab (one component, two surfaces).
// Only the surrounding chrome differs: the hub adds its keybind bar and back button, and
// passes onOpen so a row opens the sidebar detail instead of the hub's session jump.
import { useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, fmtDurationMs, openSessionByPath } from "../../../store";
import { SubControls, SteerInput } from "./SubControls";
import { SubStatusPill } from "./SubStatusPill";
import { modelShort, tokenTotal, usageSegments, timeSegments, STATUS_ORDER, subStatus, currentProgress, type SegT } from "./subShared";
import type { SubagentState } from "../../../types/session";

// The subset of the open-session snapshot the roster reads; both surfaces pass the live
// session object, whose extra fields stay invisible to the roster.
export type RosterSession = { sessionId: string; subagents: Map<string, SubagentState> };

// Relative age for the roster's "active N ago" column (seconds bucketed like the TUI's formatAge)
function ageText(sec: number, t: SegT): string {
  if (sec < 5) return t("right.closedNow");
  if (sec < 3600) return t("right.closedMin", { n: Math.floor(sec / 60) || 1 });
  if (sec < 86400) return t("right.closedHour", { n: Math.floor(sec / 3600) });
  return t("right.closedDay", { n: Math.floor(sec / 86400) });
}

type SubEntry = [string, SubagentState];
// prefix: bash-tree rail string drawn from the ancestor last-sibling flags ("" for roots)
export type Row = { id: string; sub: SubagentState; depth: number; prefix: string; last: boolean };

// Project the subagent map into display rows: status order first (running → completed →
// failed → aborted), registration order within one status; tree mode nests children under
// their parent by display-name lookup (parent ids are not persisted, names are).
export function buildRows(subs: SubEntry[], mode: "flat" | "tree"): Row[] {
  const sorted = [...subs].sort(
    (a, b) => (STATUS_ORDER[subStatus(a[1])] ?? 9) - (STATUS_ORDER[subStatus(b[1])] ?? 9),
  ); // stable sort keeps registration (Map insertion) order within one status
  if (mode === "flat") return sorted.map(([id, sub]) => ({ id, sub, depth: 0, prefix: "", last: false }));
  const byName = new Map<string, SubEntry>();
  for (const entry of sorted) {
    const name = entry[1].name ?? entry[1].agent;
    if (!byName.has(name)) byName.set(name, entry);
  }
  const rows: Row[] = [];
  const visit = (entry: SubEntry, depth: number, ancestorLast: boolean[], last: boolean) => {
    const prefix = depth === 0 ? "" : ancestorLast.map((l) => (l ? "    " : "│   ")).join("") + (last ? "└── " : "├── ");
    rows.push({ id: entry[0], sub: entry[1], depth, prefix, last });
    const name = entry[1].name ?? entry[1].agent;
    const children = sorted.filter(([, c]) => (c.parent ?? "Main") === name && c !== entry[1]);
    children.forEach((child, i) => visit(child, depth + 1, [...ancestorLast, last], i === children.length - 1));
  };
  const roots = sorted.filter(([, s]) => {
    const p = s.parent ?? "Main";
    return p === "Main" || !byName.has(p);
  });
  roots.forEach((entry, i) => visit(entry, 0, [], roots.length > 1 ? i === roots.length - 1 : false));
  return rows;
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
  const mode = useAppStore((st) => st.hubMode);
  const sig = s ? [...s.subagents].map(([id, x]) => `${id}:${x.status}:${x.name ?? ""}:${x.parent ?? ""}`).join(";") : "";
  return useMemo(() => (s ? buildRows([...s.subagents], mode) : []), [sig, mode]);
}

// Roster header (mode toggle + status counts) and the aggregate usage line
export function RosterHead({ s }: { s: RosterSession }) {
  const { t } = useTranslation();
  const hubMode = useAppStore((st) => st.hubMode);

  const agg = useMemo(() => {
    let cost = 0, dur = 0, reqs = 0, tools = 0, tok = 0, measured = 0, timed = 0;
    for (const [, sub] of s.subagents) {
      const u = sub.usage;
      if (!u) continue;
      measured++;
      cost += u.cost ?? 0;
      dur += u.durationMs ?? 0;
      reqs += u.requests ?? 0;
      tools += u.toolCount ?? sub.tools.length;
      tok += tokenTotal(u.tokens) ?? 0;
      if ((u.durationMs ?? 0) > 0) timed++;
    }
    return { cost, dur, reqs, tools, tok, measured, timed, total: s.subagents.size };
  }, [s]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [, sub] of s.subagents) c[subStatus(sub)] = (c[subStatus(sub)] ?? 0) + 1;
    return c;
  }, [s]);

  return (
    <>
      <div className="hub-head">
        <b>Roster</b>
        <span className="text-faint"> · </span>
        <button
          type="button"
          className={"hub-mode" + (hubMode === "flat" ? " on" : "")}
          onClick={() => hubMode !== "flat" && useAppStore.getState().toggleHubMode()}
        >
          {t("right.hubFlat")}
        </button>
        <span className="text-faint"> / </span>
        <button
          type="button"
          className={"hub-mode" + (hubMode === "tree" ? " on" : "")}
          onClick={() => hubMode !== "tree" && useAppStore.getState().toggleHubMode()}
        >
          {t("right.hubTree")}
        </button>
        {Object.entries(statusCounts).map(([st, n]) => (
          <span className={"text-faint hub-st st-" + st} key={st}>
            {" · "}
            {n} {st}
          </span>
        ))}
      </div>
      <div className="hub-usage text-faint">
        {agg.measured === 0 ? (
          t("right.hubNoUsage")
        ) : (
          <>
            <span className="hub-cost">${agg.cost.toFixed(3)}</span>
            {" · "}
            {agg.dur > 0 ? fmtDurationMs(agg.dur) : "—"} {t("right.hubAgentTime")}
            {" · "}
            {agg.reqs} req · {agg.tools} tools · {fmtTokens(agg.tok)} tok ·{" "}
            {t("right.hubTimed", { t: agg.timed, n: agg.measured })} · {t("right.hubMeasured", { m: agg.measured, n: agg.total })}
          </>
        )}
      </div>
    </>
  );
}

export function HubRow({ row, flat, selected, onSelect, onOpen, t, sessionId }: { row: Row; flat: boolean; selected: boolean; onSelect: () => void; onOpen?: () => void; t: SegT; sessionId: string }) {
  const { sub } = row;
  const segs = usageSegments(sub, t, { model: false });
  const times = timeSegments(sub, t, Date.now());
  // "active N ago" measures from the last activity (registered + elapsed), not registration
  const lastActivity = (sub.registeredAt ?? Date.now()) + (sub.usage?.durationMs ?? 0);
  const age = ageText(Math.max(1, Math.round((Date.now() - lastActivity) / 1000)), t);
  const model = modelShort(sub.usage?.resolvedModel);
  const rowTask = sub.description || sub.task || sub.text.slice(0, 80) || "…";
  // Steer input expands in place below the row (div root: the controls are buttons, which
  // cannot nest inside the old <button> root)
  const [steerOpen, setSteerOpen] = useState(false);
  return (
    <div
      role="option"
      aria-selected={selected}
      className={"hub-row" + (selected ? " on" : "")}
      onClick={onSelect}
      onDoubleClick={() => {
        // Sidebar tab: both clicks land on the same inspector (onOpen), so nothing to do
        if (onOpen) return onOpen();
        if (sub.sessionFile) {
          useAppStore.getState().closeHub();
          openSessionByPath(sub.sessionFile);
        }
      }}
    >
      <span className="hub-row-head">
        {row.prefix ? (
          <span className="hub-branch text-faint">{row.prefix}</span>
        ) : null}
        <SubStatusPill sub={sub} />
        <span className="hub-name">{sub.name ?? sub.agent}</span>
        {flat && sub.parent && sub.parent !== "Main" ? <span className="text-faint"> ↳ {sub.parent}</span> : null}
        {sub.streaming ? <SubControls sessionId={sessionId} agentId={row.id} onSteer={() => setSteerOpen((v) => !v)} /> : null}
        {model ? <span className="hub-model">{model}</span> : null}
      </span>
      {/* Running rows show the live progress line ("Current" in the detail) instead of the
          static assignment; it falls back to the assignment until the first tool/intent lands */}
      <span className="hub-task text-faint">{sub.streaming ? currentProgress(sub) || rowTask : rowTask}</span>
      {/* Metrics (left) and timing info (right) share one line */}
      <span className="hub-meta text-faint">
        <span className="hub-meta-usage">{segs.join(" · ")}</span>
        <span className="hub-meta-right">{times.concat(age).join(" · ")}</span>
      </span>
      {steerOpen && sub.streaming ? <SteerInput sessionId={sessionId} agentId={row.id} onClose={() => setSteerOpen(false)} /> : null}
    </div>
  );
}
