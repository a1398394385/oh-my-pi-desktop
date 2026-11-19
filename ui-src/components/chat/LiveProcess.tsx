// The live segment of the running turn. Order is fixed: the intent row (ChatLoading) on
// top, its expanding body below, the working-time row at the bottom — the body opens
// downward from the intent row, so the work-time row is pushed down rather than moving.
// The body holds the rows produced since the turn's last cut (items.tsx liveSegmentStart):
// output never folds, and neither does an edit row outside the concise style, so everything
// after that cut belongs to the current segment.
import { useState } from "react";
import { useAppStore } from "../../store/index";
import type { ChatItem } from "../../types/session";
import ChatLoading from "./ChatLoading";
import { WorkSec } from "./WorkLine";
import { renderItems } from "./items";

export default function LiveProcess({ items }: { items: ChatItem[] }) {
  // The live segment exists only for the folding styles (standard/concise): the flat styles
  // lay those rows out inline, so there is nothing to open. Both folding styles start
  // collapsed — only the standard style keeps edits outside the body (items.tsx liveCollects).
  const style = useAppStore((st) => st.uiPrefs.agentProcessStyle);
  const canExpand = (style === "standard" || style === "concise") && items.length > 0;
  const [open, setOpen] = useState(false);
  return (
    <>
      <ChatLoading onToggle={canExpand ? () => setOpen((v) => !v) : undefined} expanded={open} />
      {canExpand && open && <div className="ro-body drop">{renderItems(items, "live-", [], undefined, { noReadonlyFold: true })}</div>}
      <WorkSec />
    </>
  );
}
