// Display-side pacing for streaming tool output. The data path batches on purpose (host
// delta-coalesce 40ms + store applyDelta 100ms window), so a raw buffer lands several lines at
// a time; this reveals it at a steady rate instead of throttling the source. The reveal runs
// off rAF and stops as soon as the display catches up, so a settled row costs nothing.
import { useEffect, useRef, useState } from "react";

const CHAR_CPS = 320; // steady reveal rate while the buffer keeps growing
const CATCHUP_CPS = 1800; // burst rate once the backlog would trail visibly behind
const LAG_CHARS = 240; // backlog above which catch-up applies
const LINE_CATCHUP_LINES = 40; // backlog above which a diff reveals in batches

// One rAF tick of an append-only buffer. A non-prefix target means the buffer was rewritten
// (reset / truncation): adopt it whole, retyping would read as a glitch.
export function nextChars(shown: string, target: string, dt: number): string {
  if (!target.startsWith(shown)) return target;
  if (shown.length >= target.length) return shown;
  const behind = target.length - shown.length;
  const cps = behind > LAG_CHARS ? CATCHUP_CPS : CHAR_CPS;
  const step = Math.max(1, Math.round((cps * Math.min(dt, 100)) / 1000));
  return target.slice(0, shown.length + step);
}

// One rAF tick of a replaced buffer (host tool_preview re-sends the whole diff): lines are the
// only stable unit — every line already shown stays as-is, the rest appear line by line.
export function nextLines(shown: string, target: string): string {
  const shownCount = shown ? shown.split("\n").length : 0;
  const targetLines = target.split("\n");
  if (shownCount >= targetLines.length) return target; // shrank: accept the new frame as-is
  const behind = targetLines.length - shownCount;
  const step = behind > LINE_CATCHUP_LINES ? Math.ceil(behind / 10) : 1;
  return targetLines.slice(0, shownCount + step).join("\n");
}

function usePaced(apply: (shown: string, target: string, dt: number) => string, text: string): string {
  // Whatever already arrived at mount shows immediately (re-attach mid-stream must not replay
  // the buffer); only the growth from here on is paced.
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  useEffect(() => {
    const tick = (now: number) => {
      rafRef.current = 0;
      const dt = lastRef.current ? now - lastRef.current : 16;
      lastRef.current = now;
      const out = apply(shownRef.current, text, dt);
      if (out !== shownRef.current) {
        shownRef.current = out;
        setShown(out);
      }
      if (out !== text) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [text]);
  return shown;
}

// Character reveal for append-only buffers: a `write` body, local bash output.
export function useTypewriter(text: string): string {
  return usePaced(nextChars, text);
}

// Line reveal for buffers the host re-sends whole: an `edit` call's live diff.
export function useLineReveal(text: string): string {
  return usePaced(nextLines, text);
}
