// Subagent roster: row projection + roster rows + the header/usage summary, shared by the
// middle-card Agent Hub and the right-sidebar subagent tab (one component, two surfaces).
// Only the surrounding chrome differs: the hub adds its keybind bar and back button, and
// passes onOpen so a row opens the sidebar detail instead of the hub's session jump.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, fmtDurationMs, openSessionByPath } from "../../../store";
import { expandRightPanel } from "../../main/right/tabs";
import { SubControls } from "./SubControls";
import { modelShort, tokenTotal, usageSegments, timeSegments, stInfo, stKeyOf, stLabel, subStatus, currentProgress, type SegT } from "./subShared";
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

// Relative age for the roster's "active N ago" column (seconds bucketed like the TUI's formatAge)
function ageText(sec: number, t: SegT): string {
  if (sec < 5) return t("right.closedNow");
  if (sec < 3600) return t("right.closedMin", { n: Math.floor(sec / 60) || 1 });
  if (sec < 86400) return t("right.closedHour", { n: Math.floor(sec / 3600) });
  return t("right.closedDay", { n: Math.floor(sec / 86400) });
}

type SubEntry = [string, SubagentState];
export type Row = { id: string; sub: SubagentState };

// Project the subagent map into display rows: status order first (running → completed →
// failed → aborted → unknown), registration order within one status. `status` is the status
// tab's selection: "all", or a display-group key (unknown tokens group under themselves).
export function buildRows(subs: SubEntry[], status = "all"): Row[] {
  return [...subs]
    .sort((a, b) => stInfo(subStatus(a[1])).order - stInfo(subStatus(b[1])).order) // stable sort keeps registration (Map insertion) order within one status
    .filter(([, sub]) => status === "all" || stKeyOf(subStatus(sub)) === status)
    .map(([id, sub]) => ({ id, sub }));
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

// One usage stat. Its width floor only ever grows: the aggregates tick up and then reset when
// the roster empties, and a cell that shrank would drag the whole line left on every update.
// The floor is measured off the inline span (the div itself is already stretched by min-width,
// so it cannot report the text's natural width).
function UsageCell({ children }: { children: ReactNode }) {
  const text = useRef<HTMLSpanElement>(null);
  const [floor, setFloor] = useState(0);
  useLayoutEffect(() => {
    const w = Math.ceil(text.current?.getBoundingClientRect().width ?? 0);
    if (w > floor) setFloor(w);
  });
  return (
    <div className="hub-cell" style={{ minWidth: floor }}>
      <span ref={text}>{children}</span>
    </div>
  );
}

// Narrow-card degradation: instead of squeezing the title to nothing, the head drops its tail
// in product order (model name → row controls → model role → title) and the metrics line
// loses its rightmost cells one by one. Measured, because the drop point follows the live
// labels, not a fixed breakpoint. Items carry data-prio (1 hides first); the title may shrink
// to its data-min before the tail is dropped, so a long title alone never costs a whole badge.
// `.hub-off` is toggled straight on the DOM (React never writes it, so a later render of the
// same className cannot resurrect a hidden item).
function measureRow(box: HTMLElement) {
  // display:contents wrappers (the model group) are not boxes: their children are the real
  // flex items, so both measurement and the hide toggles address them.
  const kids: HTMLElement[] = [];
  const collect = (parent: HTMLElement) => {
    for (const el of [...parent.children] as HTMLElement[]) {
      if (!el.dataset.prio && getComputedStyle(el).display === "contents") collect(el);
      else kids.push(el);
    }
  };
  collect(box);
  kids.forEach((k) => k.classList.remove("hub-off"));
  // Measure with flex:none: a stretched item (the title, flex:1) reports the space it was
  // given, not the text it wants. Restored right after, so the row is untouched afterwards.
  const flexes = kids.map((k) => k.style.flex);
  kids.forEach((k) => { k.style.flex = "none"; });
  const widths = kids.map((k) => Math.max(k.getBoundingClientRect().width, k.scrollWidth));
  kids.forEach((k, i) => { k.style.flex = flexes[i]; });
  const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
  return { kids, widths, gap, avail: box.clientWidth };
}

function useHeadFit(ref: { current: HTMLElement | null }, sig: string) {
  useLayoutEffect(() => {
    const head = ref.current;
    if (!head) return;
    let lastW = -1;
    const run = () => {
      // Panel drags repaint without a React render, so the box is watched too; the same width
      // is skipped because toggling items can change the height and re-enter the observer.
      if (head.clientWidth === lastW || !head.clientWidth) return;
      lastW = head.clientWidth;
      const { kids, widths, gap, avail } = measureRow(head);
      const prio = kids.map((k) => Number(k.dataset.prio ?? 99));
      const width = kids.map((k, i) => (k.dataset.min ? Math.min(widths[i], Number(k.dataset.min)) : widths[i]));
      let lvl = 0;
      for (; lvl < 5; lvl++) {
        let used = 0, n = 0;
        for (let i = 0; i < kids.length; i++) {
          if (prio[i] <= lvl) continue;
          used += width[i];
          n++;
        }
        if (used + gap * Math.max(0, n - 1) <= avail) break;
      }
      kids.forEach((k, i) => k.classList.toggle("hub-off", prio[i] <= lvl));
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(head);
    return () => ro.disconnect();
  }, [ref, sig]);
}

function useMetaFit(ref: { current: HTMLElement | null }, sig: string) {
  useLayoutEffect(() => {
    const meta = ref.current;
    if (!meta) return;
    let lastW = -1;
    const run = () => {
      if (meta.clientWidth === lastW || !meta.clientWidth) return;
      lastW = meta.clientWidth;
      const { kids, widths, gap, avail } = measureRow(meta);
      let kept = kids.length;
      while (kept > 1 && widths.slice(0, kept).reduce((a, w) => a + w, 0) + gap * (kept - 1) > avail) kept--;
      kids.forEach((k, i) => k.classList.toggle("hub-off", i >= kept));
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(meta);
    return () => ro.disconnect();
  }, [ref, sig]);
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

// Aggregate usage over every measured subagent of the session (an Agent Hub-only line).
export function HubUsage({ s }: { s: RosterSession }) {
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
  return (
    <div className="hub-usage text-faint">
      {agg.measured === 0 ? (
        t("right.hubNoUsage")
      ) : (
        <>
          <UsageCell>
            <span className="hub-cost">${agg.cost.toFixed(3)}</span>
          </UsageCell>
          <UsageCell>
            {agg.dur > 0 ? fmtDurationMs(agg.dur) : "—"} {t("right.hubAgentTime")}
          </UsageCell>
          <UsageCell>{agg.reqs} req</UsageCell>
          <UsageCell>{agg.tools} tools</UsageCell>
          <UsageCell>{fmtTokens(agg.tok)} tok</UsageCell>
        </>
      )}
    </div>
  );
}

export function HubRow({ row, stats, selected, onSelect, onOpen, t, sessionId }: { row: Row; stats: boolean; selected: boolean; onSelect: () => void; onOpen?: () => void; t: SegT; sessionId: string }) {
  const { sub } = row;
  const segs = usageSegments(sub, t, { model: false });
  const times = timeSegments(sub, t, Date.now());
  // "active N ago" measures from the last activity (registered + elapsed), not registration
  const lastActivity = (sub.registeredAt ?? Date.now()) + (sub.usage?.durationMs ?? 0);
  const age = ageText(Math.max(1, Math.round((Date.now() - lastActivity) / 1000)), t);
  // Role alias (TASK/SMOL) rides left of the model id, " · "-joined; absent for concrete-model runs
  const role = sub.usage?.modelRole?.toUpperCase();
  // The base hands the level either as a `<model>:<level>` suffix (modelShort translates it) or
  // as resolvedThinkingLevel; both land as the same second run, separated by one space.
  const short = modelShort(sub.usage?.resolvedModel);
  const cut = short.lastIndexOf(":");
  const model = cut > 0 ? short.slice(0, cut) : short;
  const thinkRaw = sub.usage?.resolvedThinkingLevel ?? (cut > 0 ? short.slice(cut + 1) : "");
  const think = thinkRaw ? t(`composer.thinkingLevels.${thinkRaw}`, { defaultValue: thinkRaw }) : "";
  const headRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  useHeadFit(headRef, `${sub.agent}|${sub.name ?? ""}|${role}|${model}|${think ?? ""}|${sub.streaming ? 1 : 0}`);
  // `stats` is in the key: dropping the metrics line unmounts it, and the fitter has to run
  // again when the line comes back (a stable key would leave the effect from mounting).
  useMetaFit(metaRef, segs.join("|") + "#" + times.concat(age).join("|") + (stats ? "#1" : "#0"));
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
      <span className="hub-row-head" ref={headRef}>
        <span className={"hub-dot st-" + stInfo(subStatus(sub)).group} />
        <span className="hub-name" data-prio="5" data-min="48">{sub.name ?? sub.agent}</span>
        {sub.streaming ? <SubControls sessionId={sessionId} agentId={row.id} onOpen={() => openSubagentSession(row.id, sub)} /> : null}
        {role || model || think ? (
          <span className="hub-model">
            {role ? <span className="hub-role" data-prio="3">{role}</span> : null}
            {role && (model || think) ? <span className="hub-sep" data-prio="1"> · </span> : null}
            {model || think ? (
              <span className="hub-mdl" data-prio="1">
                {model}
                {model && think ? " " : null}
                {think ? <span className="hub-think">{think}</span> : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      {/* Running rows show the live progress line ("Current" in the detail) instead of the
          static assignment; it falls back to the assignment until the first tool/intent lands.
          The completion probe's self-estimate leads the line while the child runs (the probe
          stops at terminal status, and a yield pins it to 99). */}
      <span className="hub-task text-faint" title={rawTask || undefined}>
        {sub.streaming && sub.usage?.completionPercent !== undefined ? (
          <span className="hub-pct">{sub.usage.completionPercent}%</span>
        ) : null}
        {sub.streaming ? currentProgress(sub) || rowTask : rowTask}
      </span>
      {/* Metrics (left) and timing info (right) share one line; the host surface decides
          whether a card carries it (Agent Hub yes, right sidebar no) */}
      {stats ? (
        <div className="hub-meta text-faint" ref={metaRef}>
          {segs.map((s, i) => (
            <UsageCell key={"u" + i}>{s}</UsageCell>
          ))}
          {times.concat(age).map((s, i) => (
            <UsageCell key={"t" + i}>{s}</UsageCell>
          ))}
        </div>
      ) : null}
    </div>
  );
}
