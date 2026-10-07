// Level-2 fold: merges a run of >=3 consecutive read-only tool events (scanned in
// items.tsx scanReadonlyRun) into one "Explored N files, M tasks, ran K commands" block.
// Expanding renders the inner items through renderItems, so the existing level-3 merges
// (read/terminal/change/device groups) nest inside; thinking items collected into the run
// render inside the block but are not counted. Structure mirrors ReadGroup in EditRow.tsx
// (title row + WeakMap expand state + useLift collapse animation).
import type { ChatItem, ToolItem } from "../../types/session";
import { bumpGroupExpand, useGroupExpandVersion, roExpand } from "../../store/groupExpand";
import { useEffect, useRef } from "react";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { useLift, uniqueFiles } from "./parts";
import { isCmdEvent, isReadonlyEvent } from "./util";
import { renderItems } from "./items";

// Block title / rail summary: "Explored 29 files, 3 tasks, ran 14 commands". read events
// count unique files (same extraction/dedup rule as ReadRow in parts.tsx), bash/shell/eval
// count calls, every other read-only event counts once; thinking is not counted and zero
// segments are omitted.
export function roSummaryText(subs: ChatItem[]): string {
  const ro = subs.filter(isReadonlyEvent);
  const files = uniqueFiles(
    ro.filter((it) => (it.name || "") === "read").flatMap((it) => (it.files?.length ? it.files : it.args?.path ? [it.args.path] : [])),
  ).length;
  const cmds = ro.filter(isCmdEvent).length;
  const tasks = ro.filter((it) => (it.name || "") !== "read" && !isCmdEvent(it)).length;
  const segs: string[] = [];
  if (files > 0) segs.push(t("chat.roFiles", { count: files }));
  if (tasks > 0) segs.push(t("chat.roTasks", { count: tasks }));
  if (cmds > 0) segs.push(t("chat.roCmds", { count: cmds }));
  return t("chat.roExplored") + segs.join(t("chat.roSep"));
}

// The run always starts with a read-only tool event (scanReadonlyRun is entered only for
// one), so the head key of the expand WeakMap is a ToolItem at runtime
export default function ReadonlyGroup({ subs, pfx }: { subs: ChatItem[]; pfx: string }) {
  useGroupExpandVersion(); // expand state lives on a module-level WeakMap; the groupExpand channel bumps to re-render
  const [closing, close] = useLift();
  const head = subs[0] as ToolItem;
  const open = roExpand.has(head) && !closing;
  const bodyRef = useRef<HTMLDivElement>(null);
  // Scroll edge fades (see .ro-body.ro-scroll/.rt/.rb in readonly-group.css): track whether
  // the body overflows and which scroll extremes are reached, so the mask only fades edges
  // with hidden content; re-runs when the expansion body mounts (content height settles via
  // ResizeObserver — inner rows can stream in while the body stays open)
  useEffect(() => {
    if (!roExpand.has(head)) return;
    const el = bodyRef.current;
    if (!el) return;
    const sync = () => {
      const scrolls = el.scrollHeight > el.clientHeight + 1;
      el.classList.toggle("ro-scroll", scrolls);
      el.classList.toggle("rt", scrolls && el.scrollTop <= 1);
      el.classList.toggle("rb", scrolls && el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [roExpand.has(head)]);
  const toggle = () => {
    if (roExpand.has(head)) close(() => { roExpand.delete(head); bumpGroupExpand(); });
    else {
      roExpand.set(head, true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act ro" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="compass" size={15} />
        <span className="lbl">{roSummaryText(subs)}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {roExpand.has(head) && (
        <div ref={bodyRef} className={"ro-body" + (closing ? " lift" : " drop")}>
          {/* already the folded run: skip the level-2 scan or the block would nest inside itself */}
          {renderItems(subs, pfx, [], undefined, { noReadonlyFold: true })}
        </div>
      )}
    </>
  );
}
