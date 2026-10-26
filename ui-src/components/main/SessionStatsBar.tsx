// Session stats bar: a permanent row under the composer dock showing session-wide
// cache hit rate / input / output / cache read / cache write / cost / active time /
// token speed / average time to first token.
// Data is pushed by the host while a turn is running (at each model-turn end / each tool
// end) and when loading a session, via session_stats frames landing on the session object's
// stats field (see store.js); no on-demand hover requests.
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useAppStore, fmtTokens, fmtDurationMs } from "../../store";
import { motionEnabled } from "../../shell";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";

function fmtTokenSpeed(speed: number | null | undefined): string {
  if (speed == null || !Number.isFinite(speed) || speed <= 0) return "—";
  return `${speed.toFixed(1)} tok/s`;
}

function fmtTtft(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function SessionStatsBar() {
  const { t } = useTranslation();
  // Current session subscription: session_stats frames go through updateSession swapping
  // the session reference, so the selector picks them up
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const activePath = useAppStore((s) => s.activePath);
  const narrow = useAppStore((s) => s.narrow);
  // Phone gate: the narrow layout hides the bar unless the remote settings page turns it
  // back on (omp-desktop.json remote.mobileStatsBar, default off). Desktop is unaffected.
  const mobileStatsBar = useAppStore((s) => s.hostSettings?.remote?.mobileStatsBar === true);
  const st = session?.stats;
  const streaming = session?.streaming === true;
  // Repaint 4x per second while the session runs: token frames only arrive at
  // model-turn / tool boundaries, so a long streaming answer would otherwise
  // freeze the active-time figure. A 1s interval both misaligns with the
  // frame's extrapolation phase (Math.round then stalls/double-steps whole
  // seconds) and gets compressed/skipped when streaming redraws block the main
  // thread — same lesson as WorkLine's WorkSec. The frame's own statsAt is the
  // baseline, so the extrapolated value stays accurate across frames.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [streaming]);
  // Cache-miss flash: the host counts prefix invalidations (cacheBreaks) and reports
  // what the last one re-billed. The first frame of a session (or of a switch) only
  // seeds the baseline — re-opening an old session must not flash for past breaks.
  const breaks = st?.cacheBreaks ?? 0;
  const [miss, setMiss] = useState<{ tokens: number; usd?: number } | null>(null);
  // Text of the previous notice: the layer keeps it while it slides back out, so the
  // return trip is not an empty strip riding up.
  const lastMiss = useRef<{ tokens: number; usd?: number } | null>(null);
  const baseline = useRef<{ path: string | null; breaks: number } | null>(null);
  useEffect(() => {
    if (!st) return;
    if (baseline.current?.path !== (activePath ?? null)) {
      baseline.current = { path: activePath ?? null, breaks };
      return;
    }
    if (breaks <= baseline.current.breaks) return;
    baseline.current.breaks = breaks;
    if (st.cacheMissTokens > 0) {
      lastMiss.current = { tokens: st.cacheMissTokens, usd: st.cacheMissUsd };
      setMiss({ tokens: st.cacheMissTokens, usd: st.cacheMissUsd });
    }
  }, [activePath, breaks, st]);
  useEffect(() => {
    if (!miss) return;
    const timer = setTimeout(() => setMiss(null), 3000);
    return () => clearTimeout(timer);
  }, [miss]);
  // Vertical carousel (the sidebar's eviction notice, along Y): the outgoing content is kept
  // one beat, so the notice rides up from below while the stats row leaves through the top —
  // and the same motion brings the row back. Flipping the content and its animation class has
  // to land in ONE paint (adjust-state-during-render), or the swap reads as an instant cut.
  // With motion reduced the outgoing copy is skipped: the global kill rule flattens both
  // animations and the two layers would otherwise sit stacked on top of each other.
  const [swap, setSwap] = useState<{ miss: boolean; prev: ReactNode | null }>({ miss: miss !== null, prev: null });
  const showMiss = miss !== null;
  useEffect(() => {
    if (swap.prev === null) return;
    const id = setTimeout(() => setSwap((s) => ({ ...s, prev: null })), 320); // slightly past the 300ms slide
    return () => clearTimeout(id);
  }, [swap.prev]);
  if (narrow && !mobileStatsBar) return null; // phone default: hidden (remote settings toggle)
  if (!st) return null; // no stats before the first turn ends (or while the session is still loading); take no space

  const activeMs = st.activeMs + (streaming && st.receivedAt !== undefined ? Date.now() - st.receivedAt : 0);
  const advisorCost = st.advisorCost ?? 0;
  const cost = (st.cost ?? 0) + advisorCost;
  // Subagent spend is not part of the host's session cost: the base only folds a blocking
  // task's spend into the parent through its toolResult usage, and the default async spawn
  // never produces one (BUG-064). Advisor transcripts already bill through advisorCost
  // above, so they are excluded here.
  let subCost = 0;
  for (const sub of session?.subagents.values() ?? []) if (!sub.advisor) subCost += sub.usage?.cost ?? 0;
  // That folded-in part (the frame's subagentCost) must not be billed twice: subtract the
  // overlap with the children summed above. min() keeps a reloaded session — whose children
  // are no longer in the store while the host still reports their spend — from dropping the
  // total below the host's own figure.
  const totalCost = cost + subCost - Math.min(subCost, st.subagentCost ?? 0);
  // Desktop keeps the original single line (same width-driven trimming as before). Narrow
  // phones split it into two fixed rows: the top one carries the three cache/token groups
  // (cache hit + breaks, cache read/write, input/output), the bottom one the remaining three
  // (cost, TTFT + token speed, active time + compactions).
  // Each metric is a line-style icon standing in for what used to be a text label
  // (TUI status-line convention); the label survives as the hover tooltip.
  type Part = { icon: string; tip: string; v: string; cls?: string; extra?: ReactNode };
  const cacheHitPart: Part = {
    icon: "database",
    tip: t("chat.statsCacheHit"),
    v: `${(st.cacheHitRate * 100).toFixed(1)}%`,
    // Cache invalidations this session (host-side counter, see buildSessionStats):
    // counter-clockwise arrow + count, display-only
    extra: (
      <span className="sb-break" title={t("chat.statsCacheBreaksTitle")}>
        <Icon name="cacheBreak" size={14} />
        {st.cacheBreaks}
      </span>
    ),
  };
  const cacheReadPart: Part = { icon: "archiveRestore", tip: t("chat.statsCacheRead"), v: fmtTokens(st.tokens.cacheRead), cls: "sb-opt-cachetok" };
  const cacheWritePart: Part = { icon: "archive", tip: t("chat.statsCacheWrite"), v: fmtTokens(st.tokens.cacheWrite), cls: "sb-opt-cachetok" };
  const inputPart: Part = { icon: "moveDown", tip: t("chat.statsInput"), v: fmtTokens(st.tokens.input) };
  const outputPart: Part = { icon: "moveUp", tip: t("chat.statsOutput"), v: fmtTokens(st.tokens.output) };
  const speedPart: Part = { icon: "zap", tip: t("chat.statsTokenSpeed"), v: fmtTokenSpeed(st.tokenSpeed) };
  const ttftPart: Part = { icon: "timer", tip: t("chat.statsAvgTtft"), v: fmtTtft(st.avgTtft), cls: "sb-opt-ttft" };
  const durationPart: Part = { icon: "clock", tip: t("chat.statsDuration"), v: fmtDurationMs(activeMs), cls: "sb-opt-duration" };
  // Parenthetical detail after the total: subagent spend, then the advisor's, " | "-joined;
  // zero parts stay hidden so the separator only appears when both are billed.
  const detailParts = [subCost > 0 ? `$${subCost.toFixed(4)}` : "", advisorCost > 0 ? `$${advisorCost.toFixed(4)}` : ""].filter(Boolean);
  const costPart: Part | null = totalCost > 0
    ? { icon: "circleDollarSign", tip: t("chat.statsCost"), v: `$${totalCost.toFixed(4)}` + (detailParts.length > 0 ? ` (${detailParts.join(" | ")})` : ""), cls: "sb-opt-cost" }
    : null;
  // Rightmost: context compactions this session (both the base chain and the desktop ACP
  // chain). Its cacheRead drop is deliberately not counted as a cache break
  // (host/session-snapshot.ts countCacheBreaks), so this is where that loss is accounted for.
  const compactionsPart: Part = { icon: "compress", tip: t("chat.statsCompactions"), v: String(st.compactions) };
  // Desktop groups: cache used/breaks | cache read/write | in/out | cost | TTFT/speed |
  // active time/compactions
  const desktopGroups: Part[][] = [
    [cacheHitPart],
    [cacheReadPart, cacheWritePart],
    [inputPart, outputPart],
    costPart ? [costPart] : [],
    [ttftPart, speedPart],
    [durationPart, compactionsPart],
  ];
  // Narrow rows: top = cache used/breaks / cache read/write / in/out;
  // bottom = cost / TTFT + speed / active time + compactions.
  const tokenGroups: Part[][] = [
    [cacheHitPart],
    [cacheReadPart, cacheWritePart],
    [inputPart, outputPart],
  ];
  const otherGroups: Part[][] = [
    costPart ? [costPart] : [],
    [ttftPart, speedPart],
    [durationPart, compactionsPart],
  ].filter((g) => g.length > 0);
  const renderGroup = (parts: Part[], gi: number) => (
    <span className="sb-group" key={gi}>
      {parts.map((p) => (
        <span className={"sb-item" + (p.cls ? " " + p.cls : "")} key={p.tip} title={p.tip}>
          <span className="sb-ic">
            <Icon name={p.icon} size={13} />
          </span>
          <span className="text-dim">{p.v}</span>
          {p.extra}
        </span>
      ))}
    </span>
  );
  const renderRow = (gs: Part[][], row: string) => (
    <div className={"sb-row " + row}>{gs.map(renderGroup)}</div>
  );

  // Both layers share one grid cell (composer.css). The notice text outlives `miss`
  // (lastMiss) so the exit leg slides out with its text, not an empty strip.
  const missData = miss ?? lastMiss.current;
  const statsNode = narrow ? (
    <>
      {renderRow(tokenGroups, "sb-row-token")}
      {renderRow(otherGroups, "sb-row-other")}
    </>
  ) : (
    desktopGroups.map(renderGroup)
  );
  const missNode = missData ? (
    <span className="sb-miss">
      {missData.usd === undefined
        ? t("chat.statsCacheMiss", { tokens: fmtTokens(missData.tokens) })
        : t("chat.statsCacheMissUsd", { tokens: fmtTokens(missData.tokens), usd: `$${missData.usd.toFixed(2)}` })}
    </span>
  ) : null;
  if (swap.miss !== showMiss) {
    setSwap({ miss: showMiss, prev: motionEnabled() ? (swap.miss ? missNode : statsNode) : null });
  }
  const body = showMiss ? missNode : statsNode;
  return (
    <div className="stats-bar" id="statsBar">
      {swap.prev !== null && <div className="sb-layer sb-prev">{swap.prev}</div>}
      <div className={"sb-layer sb-next" + (swap.prev !== null ? " sliding" : "")}>{body}</div>
    </div>
  );
}
