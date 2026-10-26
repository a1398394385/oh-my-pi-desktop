// Run sealing: the live turn's process collapses into one loop group at run end. Split out
// of store/session.ts to keep that hot file under its line ratchet.
//
// Error rows fold into the group like any other event — a failed attempt inside a run is
// one more thing that happened, not the run's outward result. Same layout as the reload
// path (host/translate-history.ts); the row is still readable once the group is expanded.
// Advisor rows stay INSIDE too: an injected note is one more event of the same run, so the
// reader still sees a single "process" group per turn. The renderer lifts an advice row
// back out when the group is collapsed and would hide it.
import type { OpenSession, SessionItem } from "../types/session";
import type { TurnUsage } from "../types/frames";

export function sealRunItems(s: OpenSession, usage?: TurnUsage | null): void {
  const startIdx = s.turnItemStart ?? s.items.length;
  const runItems = s.items.splice(startIdx);
  // A mid-run attach receives the partial turn as its own loop group (transcript rebuilds
  // fold it, host/translate-history.ts); un-nest it so the sealed group is one flat run,
  // matching the reload view instead of leaving a cut at the attach moment.
  const flat: SessionItem[] = [];
  for (const it of runItems) {
    if (it.role === "loop" && it.items) flat.push(...it.items);
    else flat.push(it);
  }
  // Outward result = every turn-final assistant text (turnFinal: the turn ended stopReason
  // "stop" — a delivered output, even when a mid-run wake kept the run going afterwards),
  // plus the trailing assistant as the pre-mark fallback (covers error/aborted tails).
  // Advice rows (a note about the output before them) and error rows (folded like any other
  // event) sit after that output, so skip both when scanning for the tail. One pass keeps
  // stream order.
  let lastA = flat.length - 1;
  while (lastA >= 0 && (flat[lastA].role === "advisor" || flat[lastA].role === "error")) lastA--;
  const tailIdx = flat[lastA]?.role === "assistant" ? lastA : -1;
  const kept: SessionItem[] = [];
  const finalOut: SessionItem[] = [];
  flat.forEach((it, i) => {
    (it.role === "assistant" && (it.turnFinal || i === tailIdx) ? finalOut : kept).push(it);
  });
  if (kept.length) {
    s.items.push({
      role: "loop",
      text: "",
      collapsed: true,
      items: kept,
      durationSec: s.turnStartAt ? Math.round((Date.now() - s.turnStartAt) / 1000) : null,
      usage: usage ?? null,
    });
  }
  s.items.push(...finalOut);
  s.turnItemStart = s.items.length;
}

// Text of the error row a run ended on, else null. Pre-seal only (session.ts turn_end):
// the base auto-retries a failed request, so a mid-run failure leaves its row above the
// retry's own output — only a row at the very tail means the run was interrupted.
// Annotation rows (advisor note / ttsr notice / mention read-back) can land after the
// failure row and are skipped.
export function endingErrorText(items: readonly SessionItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "error") return it.text;
    if (it.role === "advisor" || it.role === "ttsr" || it.role === "mention") continue;
    return null;
  }
  return null;
}

// A run that ended on an error row (sidebar dot): the row folds into the
// group instead of sitting last, so scan the turn's tail for it.
export function turnEndedWithError(items: readonly SessionItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === "user") return false;
    if (it.role === "error") return true;
    if (it.role === "loop") {
      if (it.items?.some((x) => x.role === "error")) return true;
      continue;
    }
  }
  return false;
}
