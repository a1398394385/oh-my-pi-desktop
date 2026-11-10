// 3a: consecutive same-kind delta coalescing. text_delta / thinking_delta arrive
// per token with no host-side throttle (the frontend merges at 100ms); a 40ms
// window batches each run into one frame with concatenated text — same frame
// shape, seq stamped fresh at flush. Any other frame flushes first (ordering
// correctness beats merge rate); teardown flushes so no frame is stranded.
// tool_preview is the exception per-call: the native preview pump re-sends the
// whole diff, so a newer frame replaces the pending one instead of appending.
import type { UiEvent } from "./wire/payloads.ts";

const DELTA_COALESCE_MS = 40;

type DeltaEvent = Extract<UiEvent, { kind: "text_delta" | "thinking_delta" | "tool_args" | "tool_preview" }>;

/** A delta run continues only while kind and (for tool frames) the call stay the same. */
function sameRun(p: DeltaEvent, ui: DeltaEvent): boolean {
  if (p.kind !== ui.kind) return false;
  if (p.kind === "tool_preview" && ui.kind === "tool_preview") return p.toolCallId === ui.toolCallId;
  if (p.kind !== "tool_args" || ui.kind !== "tool_args") return true;
  return p.toolCallId === ui.toolCallId && !ui.reset;
}

/** One session's buffered emit; `emit` receives the full frame payload (caller stamps/sends). */
export function createDeltaCoalescer(emit: (payload: UiEvent) => void): { push: (ui: UiEvent | null) => void; flush: () => void } {
  let pending: DeltaEvent | null = null;
  let timer: Timer | null = null;
  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const p = pending;
    if (!p) return;
    pending = null;
    emit(p);
  };
  return {
    push(ui) {
      if (!ui) return;
      if (ui.kind !== "text_delta" && ui.kind !== "thinking_delta" && ui.kind !== "tool_args" && ui.kind !== "tool_preview") {
        flush();
        emit(ui);
        return;
      }
      const p = pending;
      if (p && sameRun(p, ui)) {
        // A newer preview batch re-sends the whole diff: replace, never append.
        if (ui.kind === "tool_preview") {
          pending = ui;
          return;
        }
        if (p.kind === "text_delta" || p.kind === "thinking_delta" || p.kind === "tool_args") {
          p.text += ui.text;
          // The path rides the first frames; a later frame repeating it must not blank it.
          if (p.kind === "tool_args" && ui.kind === "tool_args" && p.path === undefined) p.path = ui.path;
        }
        return;
      }
      flush(); // kind/tool switch (text↔thinking, another call): emit the previous run before buffering
      pending = ui;
      if (timer === null) timer = setTimeout(flush, DELTA_COALESCE_MS);
    },
    flush,
  };
}
