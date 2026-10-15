// Session stats bar: a permanent row under the composer dock showing session-wide
// cache hit rate / input / output / cache read / cache write / cost / active time /
// token speed / average time to first token.
// Data is pushed by the host while a turn is running (at each model-turn end / each tool
// end) and when loading a session, via session_stats frames landing on the session object's
// stats field (see store.js); no on-demand hover requests.
import { useEffect, useReducer, type ReactNode } from "react";
import { useAppStore, fmtTokens, fmtDurationMs } from "../../store";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { cn } from "../ui/cn";

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
  if (!st) return null; // no stats before the first turn ends (or while the session is still loading); take no space

  const activeMs = st.activeMs + (streaming && st.receivedAt !== undefined ? Date.now() - st.receivedAt : 0);
  const cost = (st.cost ?? 0) + (st.advisorCost ?? 0);
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
  // Semantic groups (cache / tokens / cost / performance): tighter spacing inside
  // a group than between groups. Parts tagged .sb-opt-* are trimmed by the row's
  // own width (CSS container query in composer.css), so the line never wraps.
  // Each metric is a line-style icon standing in for what used to be a text label
  // (TUI status-line convention); the label survives as the hover tooltip.
  type Part = { icon: string; tip: string; v: string; cls?: string; extra?: ReactNode };
  const groups: Part[][] = [
    [
      {
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
      },
      { icon: "download", tip: t("chat.statsCacheRead"), v: fmtTokens(st.tokens.cacheRead), cls: "sb-opt-cachetok" },
      { icon: "upload", tip: t("chat.statsCacheWrite"), v: fmtTokens(st.tokens.cacheWrite), cls: "sb-opt-cachetok" },
    ],
    [
      { icon: "arrowDownToLine", tip: t("chat.statsInput"), v: fmtTokens(st.tokens.input) },
      { icon: "arrowUpFromLine", tip: t("chat.statsOutput"), v: fmtTokens(st.tokens.output) },
    ],
    totalCost > 0
      ? [{ icon: "circleDollarSign", tip: t("chat.statsCost"), v: `$${totalCost.toFixed(4)}` + (subCost > 0 ? ` ($${subCost.toFixed(4)})` : ""), cls: "sb-opt-cost" }]
      : [],
    [
      { icon: "zap", tip: t("chat.statsTokenSpeed"), v: fmtTokenSpeed(st.tokenSpeed) },
      { icon: "timer", tip: t("chat.statsAvgTtft"), v: fmtTtft(st.avgTtft), cls: "sb-opt-ttft" },
      { icon: "clock", tip: t("chat.statsDuration"), v: fmtDurationMs(activeMs), cls: "sb-opt-duration" },
    ],
  ];

  return (
    <div className="stats-bar" id="statsBar">
      {groups.map((parts, gi) => (
        <span className="sb-group" key={gi}>
          {parts.map((p) => (
            <span className={cn("sb-item", p.cls)} key={p.tip} title={p.tip}>
              <span className="sb-ic">
                <Icon name={p.icon} size={13} />
              </span>
              <span className="text-dim">{p.v}</span>
              {p.extra}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}
