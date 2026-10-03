import { useEffect, useMemo, useState } from "react";
import type { TraceSpanKind } from "../types";

export interface TraceTheme {
  category: Record<TraceSpanKind, string>;
  error: string;
  errorSoft: string;
  marker: string;
  turnBand: string;
  grid: string;
  tick: string;
  spanText: string;
  selection: string;
  brush: string;
  fontSans: string;
  fontMono: string;
}

export const CATEGORY_VARS: Record<TraceSpanKind, string> = {
  turn: "--dim",
  model: "--accent",
  tool: "--orange",
  subagent: "--purple",
  background: "--faint",
};

function readTheme(): TraceTheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    category: {
      turn: v(CATEGORY_VARS.turn, "#b0b0b6"),
      model: v(CATEGORY_VARS.model, "#4a9eff"),
      tool: v(CATEGORY_VARS.tool, "#e5a14e"),
      subagent: v(CATEGORY_VARS.subagent, "#a86fe0"),
      background: v(CATEGORY_VARS.background, "#8c8c92"),
    },
    error: v("--err", "#ff5f57"),
    errorSoft: v("--bad-soft", "rgba(255, 95, 87, 0.15)"),
    marker: v("--text", "#ededef"),
    turnBand: v("--panel-2", "rgba(255, 255, 255, 0.035)"),
    grid: v("--line", "rgba(255, 255, 255, 0.08)"),
    tick: v("--dim", "#8c8c92"),
    spanText: v("--text", "#ffffff"),
    selection: v("--accent", "#4a9eff"),
    brush: v("--select", "rgba(255, 255, 255, 0.1)"),
    fontSans: v("--sans", "system-ui, sans-serif"),
    fontMono: v("--mono", "ui-monospace, monospace"),
  };
}

export function useTraceTheme(): TraceTheme {
  const [attrVersion, setAttrVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setAttrVersion((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return useMemo(readTheme, [attrVersion]);
}
