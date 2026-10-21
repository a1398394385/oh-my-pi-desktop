// Run sealing: the live turn's process collapses into one loop group at run end. Split out
// of store/session.ts to keep that hot file under its line ratchet.
//
// Error rows stay outside the group (the reason the run stopped must not fold away, same
// layout as the reload path); advisor rows stay INSIDE — an injected note is one more
// event of the same run, so the reader still sees a single "process" group per turn. The
// renderer lifts an advice row back out when the group is collapsed and would hide it.
import type { OpenSession, SessionItem } from "../types/session";
import type { TurnUsage } from "../types/frames";

export function sealRunItems(s: OpenSession, usage?: TurnUsage | null): void {
  const startIdx = s.turnItemStart ?? s.items.length;
  const runItems = s.items.splice(startIdx);
  const errors: SessionItem[] = [];
  for (let i = runItems.length - 1; i >= 0; i--) {
    const it = runItems[i];
    if (it.role !== "error") break;
    errors.unshift(it);
    runItems.splice(i, 1);
  }
  // Same rule as the reload path: only a trailing assistant is the outward result, skipping
  // advice rows that end the run (they annotate the output before them and are lifted to the
  // turn-tail card) — otherwise the final answer folds into the collapsed group.
  let lastA = runItems.length - 1;
  while (lastA >= 0 && runItems[lastA].role === "advisor") lastA--;
  if (runItems[lastA]?.role !== "assistant") lastA = -1;
  const finalOut = lastA >= 0 ? runItems.splice(lastA, 1) : [];
  if (runItems.length) {
    s.items.push({
      role: "loop",
      text: "",
      collapsed: true,
      items: runItems,
      durationSec: s.turnStartAt ? Math.round((Date.now() - s.turnStartAt) / 1000) : null,
      usage: usage ?? null,
    });
  }
  s.items.push(...finalOut, ...errors);
  s.turnItemStart = s.items.length;
}
