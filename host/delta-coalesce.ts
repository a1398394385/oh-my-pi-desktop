// 3a: consecutive same-kind delta coalescing. text_delta / thinking_delta arrive
// per token with no host-side throttle (the frontend merges at 100ms); a 40ms
// window batches each run into one frame with concatenated text — same frame
// shape, seq stamped fresh at flush. Any other frame flushes first (ordering
// correctness beats merge rate); teardown flushes so no frame is stranded.
import type { UiEvent } from "./wire/payloads.ts";

const DELTA_COALESCE_MS = 40;

type DeltaEvent = Extract<UiEvent, { kind: "text_delta" | "thinking_delta" }>;

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
      if (ui.kind !== "text_delta" && ui.kind !== "thinking_delta") {
        flush();
        emit(ui);
        return;
      }
      if (pending && pending.kind === ui.kind) {
        pending.text += ui.text;
        return;
      }
      flush(); // kind switch (text↔thinking): emit the previous run before buffering
      pending = ui;
      if (timer === null) timer = setTimeout(flush, DELTA_COALESCE_MS);
    },
    flush,
  };
}
