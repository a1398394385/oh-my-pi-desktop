// Procedure fold: one card per work segment — every event between two outputs (scanned in
// items.tsx scanProcessSegment). Output is the only thing that never folds, so after each
// output the work behind it reads as one row: "Edited 3 files, also explored 12 files, 2 tasks".
// Expanding renders the inner items through renderItems, so the same-type merges
// (read/terminal/change/device groups) nest inside; thinking items collected into the run
// render inside the block but are not counted. Structure mirrors ReadGroup in EditRow.tsx
// (title row + WeakMap expand state + useLift collapse animation).
import type { ChatItem, ToolItem } from "../../types/session";
import { bumpGroupExpand, useGroupExpandVersion, roExpand } from "../../store/groupExpand";
import { memo, useEffect, useRef } from "react";
import Icon from "../../Icon";
import { t } from "../../i18n";
import { useLift, uniqueFiles } from "./parts";
import { isCmdEvent, isEditEvent } from "./util";
import { renderItems } from "./items";

// Files touched by the segment's edit/write/apply_patch events (unique paths, same
// extraction rule as the file chips on the edit rows). The card head leads with this count.
export function roEditedCount(subs: ChatItem[]): number {
  const paths = subs.filter(isEditEvent).flatMap((it) => (it.files?.length ? it.files : it.args?.path ? [it.args.path] : []));
  return uniqueFiles(paths).length;
}

// Block title / rail summary: "Edited 29 files, also explored 12 files, 3 tasks, 14 commands".
// Edits lead (they are what the user came to see); read events count unique files (same
// extraction/dedup rule as ReadRow in parts.tsx), bash/shell/eval count calls, every other
// event counts once; thinking is not counted and zero segments are omitted.
export function roSummaryText(subs: ChatItem[]): string {
  const tools = subs.filter((it): it is ToolItem => it.role === "tool");
  const files = uniqueFiles(
    tools.filter((it) => (it.name || "") === "read").flatMap((it) => (it.files?.length ? it.files : it.args?.path ? [it.args.path] : [])),
  ).length;
  const edited = roEditedCount(subs);
  const cmds = tools.filter(isCmdEvent).length;
  const tasks = tools.filter((it) => (it.name || "") !== "read" && !isCmdEvent(it) && !isEditEvent(it)).length;
  const segs: string[] = [];
  if (files > 0) segs.push(t("chat.roFiles", { count: files }));
  if (tasks > 0) segs.push(t("chat.roTasks", { count: tasks }));
  if (cmds > 0) segs.push(t("chat.roCmds", { count: cmds }));
  const rest = segs.join(t("chat.roSep"));
  if (edited > 0) return rest ? t("chat.roEditedLead", { count: edited }) + rest : t("chat.roEditedOnly", { count: edited });
  return t("chat.roExplored") + rest;
}

// The run always starts with a read-only tool event (scanReadonlyRun is entered only for
// one), so the head key of the expand WeakMap is a ToolItem at runtime
// memo (T2): subs is rebuilt every traversal, so the comparator keys on the caller-captured
// mutation signature (items.tsx readonlySig) plus the sub-item identities (patchActiveItem
// copies flip them) — the group re-renders when its own rows changed, not on every flush
export default memo(
  function ReadonlyGroup({ subs, pfx, sig }: { subs: ChatItem[]; pfx: string; sig: string }) {
  void sig; // comparison-only prop (see the comment above)
  useGroupExpandVersion(); // expand state lives on a module-level WeakMap; the groupExpand channel bumps to re-render
  const [closing, close, liftRef] = useLift();
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
        <Icon name={roEditedCount(subs) > 0 ? "pencil" : "compass"} size={15} />
        <span className="lbl">{roSummaryText(subs)}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {roExpand.has(head) && (
        <div ref={(el) => { bodyRef.current = el; liftRef(el); }} className="ro-body drop">
          {/* already the folded run: skip the level-2 scan or the block would nest inside itself */}
          {renderItems(subs, pfx, [], undefined, { noReadonlyFold: true })}
        </div>
      )}
    </>
  );
  },
  (a, b) =>
    a.pfx === b.pfx &&
    a.sig === b.sig &&
    a.subs.length === b.subs.length &&
    a.subs.every((x, i) => x === b.subs[i]),
);
