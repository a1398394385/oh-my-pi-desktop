// Loop group: the process archive after a turn ends (thinking/tools/intermediate
// responses) collapsed into a one-line summary; click the whole group to expand.
// Migrated from the loop branch of ui/chat.js. On expansion, sub-rows enter together (no
// stagger: the number of sub-rows is unbounded) + the lp-kids container transitions its
// grid row height 0fr→1fr; on collapse the container retracts (closing), committing and
// unmounting after 310ms.
import { useEffect, useRef } from "react";
import type { LoopItem } from "../../types/session";
import type { RailEntry } from "./chat-types";
import { fmtTokens } from "../../store/utils";
import { useAppStore } from "../../store";
import { fmtDuration } from "./util";
import Icon from "../../Icon";
import { useLift, patchActiveItem } from "./parts";
import { renderItems } from "./items";
import { t } from "../../i18n";
// Collapsed loop group summary text: worked-for duration + total usage composed of input,
// output, cache read [, cache write] token counts via the chat.workedFor / chat.totalUsage
// keys. The duration always shows (display.showTurnTime is TUI-only and hidden — the
// desktop made turn time unconditional); the usage segment stays gated by
// display.showTokenUsage (base default false, TUI parity).
export function loopSummaryText(item: LoopItem) {
  const values = useAppStore.getState().hostSettings?.values;
  const parts = [];
  if (item.durationSec != null) parts.push(t("chat.workedFor", { duration: fmtDuration(item.durationSec) }));
  if (values?.["display.showTokenUsage"] === true) {
    const u = item.usage;
    if (u) {
      const seg = [`input ${fmtTokens(u.input)}`, `output ${fmtTokens(u.output)}`, `cache read ${fmtTokens(u.cacheRead)}`];
      if (u.cacheWrite > 0) seg.push(`cache write ${fmtTokens(u.cacheWrite)}`);
      parts.push(t("chat.totalUsage", { usage: seg.join(", ") }));
    }
  }
  return parts.join(", ") || t("chat.processLog");
}

export default function LoopGroup({ item, fk, railEntries }: { item: LoopItem; fk?: string; railEntries: RailEntry[] }) {
  useAppStore((s) => s.hostSettings); // re-render on settings flips (usage/time gating reads it in render)
  const [closing, close] = useLift();
  const kidsRef = useRef<HTMLDivElement | null>(null);

  // Expand mount: sub-rows get kids-in to play the entrance animation + the container
  // expands from 0fr (semantics of the former S.animateLoopKids;
  // on streaming redraws the effect does not rerun and the animation does not replay;
  // switching sessions remounts and replays once, an accepted difference)
  useEffect(() => {
    const kids = kidsRef.current;
    if (!kids) return;
    for (const el of (kids.firstElementChild as HTMLElement | null)?.children ?? []) (el as HTMLElement).classList.add("kids-in");
    kids.style.gridTemplateRows = "0fr";
    requestAnimationFrame(() => requestAnimationFrame(() => { kids.style.gridTemplateRows = ""; }));
  }, [item.collapsed]);

  const toggle = () => {
    if (item.collapsed) {
      patchActiveItem(item, (it) => { it.collapsed = false; });
    } else {
      // Collapse: the container height retracts to 0 (0.3s, the same set as the project
      // list), committing the re-render afterward
      close(() => patchActiveItem(item, (it) => { it.collapsed = true; }), 310);
    }
  };

  return (
    <>
      {/* sealed = collapsed state: a thin separator line between the summary row and the output below (see style.css .act.loop.sealed) */}
      <div className={"act loop" + (item.collapsed && !closing ? " sealed" : "")} style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="lp-tx">{loopSummaryText(item)}</span>
        <span className={"lp-arrow" + (!item.collapsed && !closing ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {!item.collapsed && (
        // Sub-items wrapped in a container: the grid row height 0fr↔1fr transition drives
        // the whole-group expand/collapse animation (same as the project list)
        <div className={"lp-kids" + (closing ? " closing" : "")} ref={kidsRef}>
          <div className="lp-kids-in">{renderItems(item.items || [], (fk || "") + "-", railEntries)}</div>
        </div>
      )}
    </>
  );
}
