// Session stats bar: a permanent row under the composer dock showing session-wide
// cache hit rate / input / output / cache read / cache write / cost / active time /
// token speed / average time to first token.
// Data is pushed by the host while a turn is running (at each model-turn end / each tool
// end) and when loading a session, via session_stats frames landing on the session object's
// stats field (see store.js); no on-demand hover requests.
import { useEffect, useReducer } from "react";
import { useAppStore, fmtTokens, fmtDurationMs } from "../store";
import { useTranslation } from "react-i18next";

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
  const items = [
    [t("chat.statsCacheHit"), `${(st.cacheHitRate * 100).toFixed(1)}%`],
    [t("chat.statsInput"), fmtTokens(st.tokens.input)],
    [t("chat.statsOutput"), fmtTokens(st.tokens.output)],
    [t("chat.statsCacheRead"), fmtTokens(st.tokens.cacheRead)],
    [t("chat.statsCacheWrite"), fmtTokens(st.tokens.cacheWrite)],
    ...(cost > 0 ? [[t("chat.statsCost"), `$${cost.toFixed(4)}`]] : []),
    [t("chat.statsTokenSpeed"), fmtTokenSpeed(st.tokenSpeed)],
    [t("chat.statsAvgTtft"), fmtTtft(st.avgTtft)],
    [t("chat.statsDuration"), fmtDurationMs(activeMs)],
  ];

  return (
    <div className="stats-bar" id="statsBar">
      {items.map(([k, v]) => (
        <span className="inline-flex items-baseline gap-[5px]" key={k}>
          <span className="sb-k">{k}</span>
          <span className="text-dim">{v}</span>
        </span>
      ))}
    </div>
  );
}
