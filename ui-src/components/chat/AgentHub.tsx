// Agent Hub middle card (TUI parity): replaces the chat stream while open. Roster of the
// session's subagents in Flat/By-parent modes with the TUI's row layout (status glyph +
// name, model badge right, task line, metrics line), an aggregate usage summary, and the
// keybind bar at the top. Selection links to the right sidebar's hub detail page; Enter
// bridges into the regular subagent tab; x kills via kill_subagent.
import { useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, fmtDurationMs, send, openSessionByPath } from "../../store";
import { openRightTab } from "../right/tabs";
import { modelShort, tokenTotal, usageSegments, timeSegments, STATUS_ORDER, subStatus, type SegT } from "../right/subShared";
import type { SubagentState } from "../../types/session";

// Relative age for the roster's "active N ago" column (seconds bucketed like the TUI's formatAge)
function ageText(sec: number, t: SegT): string {
  if (sec < 5) return t("right.closedNow");
  if (sec < 3600) return t("right.closedMin", { n: Math.floor(sec / 60) || 1 });
  if (sec < 86400) return t("right.closedHour", { n: Math.floor(sec / 3600) });
  return t("right.closedDay", { n: Math.floor(sec / 86400) });
}

type SubEntry = [string, SubagentState];
// prefix: bash-tree rail string drawn from the ancestor last-sibling flags ("" for roots)
type Row = { id: string; sub: SubagentState; depth: number; prefix: string; last: boolean };

// Project the subagent map into display rows: status order first (running → completed →
// failed → aborted), registration order within one status; tree mode nests children under
// their parent by display-name lookup (parent ids are not persisted, names are).
function buildRows(subs: SubEntry[], mode: "flat" | "tree"): Row[] {
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

const DOUBLE_LEFT_MS = 500;

export default function AgentHub() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const hubMode = useAppStore((st) => st.hubMode);
  // Repaint the age column once per second while anything streams
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const anyStreaming = !!s && [...s.subagents.values()].some((x) => x.streaming);
  useEffect(() => {
    if (!anyStreaming) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [anyStreaming]);

  const rows = useMemo(() => (s ? buildRows([...s.subagents], hubMode) : []), [s, hubMode]);
  const lastLeftAt = useRef(0);

  // Keep the selection on a live row: default to the first row, recover when rows shrink
  useEffect(() => {
    const st = useAppStore.getState();
    if (!st.hubSel || !rows.some((r) => r.id === st.hubSel)) {
      st.setHubSel(rows[0]?.id ?? null);
    }
  }, [rows]);

  // Hub keybinds: capture phase so j/k never land in the (hidden) composer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useAppStore.getState();
      const sel = (d: number) => {
        const cur = rows.findIndex((r) => r.id === st.hubSel);
        const next = rows[Math.max(0, Math.min(cur + d, rows.length - 1))];
        if (next) st.setHubSel(next.id);
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          sel(1);
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          sel(-1);
          return;
        case "ArrowLeft": {
          // Double-tap ← closes the hub (the open gesture in reverse, TUI parity)
          const now = Date.now();
          if (now - lastLeftAt.current <= DOUBLE_LEFT_MS) st.closeHub();
          else lastLeftAt.current = now;
          return;
        }
        case "t":
          st.toggleHubMode();
          return;
        case "Enter": {
          // Open the subagent session (or fallback to subagent detail tab) and leave the hub
          const id = st.hubSel;
          if (!id) return;
          const sub = s?.subagents.get(id);
          if (sub?.sessionFile) {
            st.closeHub();
            openSessionByPath(sub.sessionFile);
            return;
          }
          st.closeHub();
          openRightTab("subagent");
          useAppStore.setState({ selectedSubagent: id, rightCollapsed: false });
          return;
        }
        case "x": {
          const id = st.hubSel;
          const sub = id ? s?.subagents.get(id) : undefined;
          if (!id || !sub || !sub.streaming) return;
          send({ type: "kill_subagent", subagentId: id });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, s]);

  // Aggregate usage line (sum over rows): cost · agent time · req · tools · tok · timed/measured
  const agg = useMemo(() => {
    let cost = 0, dur = 0, reqs = 0, tools = 0, tok = 0, measured = 0, timed = 0;
    for (const [, sub] of s?.subagents ?? []) {
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
    return { cost, dur, reqs, tools, tok, measured, timed, total: s?.subagents.size ?? 0 };
  }, [s]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [, sub] of s?.subagents ?? []) c[subStatus(sub)] = (c[subStatus(sub)] ?? 0) + 1;
    return c;
  }, [s]);

  if (!s || s.subagents.size === 0) {
    return (
      <div id="agentHub" className="hub-empty text-faint text-ui-base">
        {t("right.hubEmpty")}
      </div>
    );
  }

  const hints: [string, string][] = [
    ["j/k", t("right.hubKeySelect")],
    ["⏎", t("right.hubKeyOpen")],
    ["t", t("right.hubKeyTree")],
    ["x", t("right.hubKeyKill")],
    ["←←/Esc", t("right.hubKeyClose")],
  ];

  return (
    <div id="agentHub">
      {/* Keybind bar at the top (requirement: every shortcut's action shown here) */}
      <div className="hub-keys">
        <span className="hub-title">{t("right.hubTitle")}</span>
        {hints.map(([key, label]) => (
          <span className="hub-key" key={key}>
            <kbd>{key}</kbd>
            {label}
          </span>
        ))}
      </div>
      {/* Roster header: mode toggle + status counts, then the aggregate usage line */}
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
      {/* Roster rows */}
      <div className="hub-list" role="listbox">
        {rows.map((row) => (
          <HubRow key={row.id} row={row} flat={hubMode === "flat"} selected={row.id === hubSel} onSelect={() => useAppStore.getState().setHubSel(row.id)} t={t} />
        ))}
      </div>
    </div>
  );
}

function HubRow({ row, flat, selected, onSelect, t }: { row: Row; flat: boolean; selected: boolean; onSelect: () => void; t: SegT }) {
  const { sub } = row;
  const st = subStatus(sub);
  const segs = usageSegments(sub, t, { model: false });
  const times = timeSegments(sub, t, Date.now());
  // "active N ago" measures from the last activity (registered + elapsed), not registration
  const lastActivity = (sub.registeredAt ?? Date.now()) + (sub.usage?.durationMs ?? 0);
  const age = ageText(Math.max(1, Math.round((Date.now() - lastActivity) / 1000)), t);
  const model = modelShort(sub.usage?.resolvedModel);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={"hub-row" + (selected ? " on" : "")}
      onClick={onSelect}
      onDoubleClick={() => {
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
        <span className={"sub-dot st-" + st}>{st === "running" ? "●" : st === "completed" ? "✓" : st === "failed" ? "✗" : "○"}</span>
        <span className="hub-name">{sub.name ?? sub.agent}</span>
        {flat && sub.parent && sub.parent !== "Main" ? <span className="text-faint"> ↳ {sub.parent}</span> : null}
        {model ? <span className="hub-model">{model}</span> : null}
      </span>
      <span className="hub-task text-faint">{sub.description || sub.task || sub.text.slice(0, 80) || "…"}</span>
      {/* Metrics (left) and timing info (right) share one line */}
      <span className="hub-meta text-faint">
        <span className="hub-meta-usage">{segs.join(" · ")}</span>
        <span className="hub-meta-right">{times.concat(age).join(" · ")}</span>
      </span>
    </button>
  );
}
