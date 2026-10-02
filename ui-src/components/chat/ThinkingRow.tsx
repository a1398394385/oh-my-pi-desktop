// Thinking row: the thinking label always shows under any setting (uiPrefs.showThinking
// only decides the default expand state when streaming starts; the expand state is recorded
// on item.expanded and written by the store). Click the label row to expand/collapse
// think-body.
// Migrated from renderThink in ui/tool-labels.js; the original's viewport anchoring on
// expansion holds naturally under React — DOM node reuse + an unchanged scrollTop means
// "the clicked row does not move", and when glued to the bottom Chat's scroll effect pins it.
import { useEffect, useRef } from "react";
import Icon from "../../Icon";
import { useLift, patchActiveItem } from "./parts";
import { t } from "../../i18n";

// Minimal renderable shape of a thinking row: the thinking entry itself; when a tool entry
// (name === "thinking") is routed in via the ToolRow fallback, these optional fields are
// undefined at runtime (structurally compatible, no assertion needed)
interface ThinkRowItem {
  text: string;
  thinking?: string;
  expandable?: boolean;
  expanded?: boolean;
  streaming?: boolean;
}

export default function ThinkingRow({ item, fk }: { item: ThinkRowItem; fk?: string }) {
  const [closing, close] = useLift();
  const expandable = item.expandable || item.thinking;
  const open = item.expanded && !closing;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // think-scroll bottom blur release: add no-fade when scrolled to the bottom (or content
  // shorter than one screen) (scrolling duty is on the inner .think-scroll: the outer layer
  // keeps its natural height so the left vertical line never scrolls out of view)
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const sync = () => sc.classList.toggle("no-fade", sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1);
    sc.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    return () => sc.removeEventListener("scroll", sync);
  }, [open]);

  const toggle = () => {
    if (item.expanded) close(() => patchActiveItem(item, (it) => { it.expanded = false; }));
    else patchActiveItem(item, (it) => { it.expanded = true; });
  };

  return (
    <>
      <div
        className="act think"
        data-fk={fk || undefined}
        style={expandable ? { cursor: "pointer" } : undefined}
        onClick={expandable ? toggle : undefined}
      >
        <span className="th-ic"><Icon name="think" size={13} /></span>
        <span className="lbl">{item.text || t("chat.thinkingFallback")}</span>
        {expandable && (
          <span className={"th-more" + (open ? " open" : "")}>
            <Icon name="chevronRight" size={10} />
          </span>
        )}
      </div>
      {open && (item.thinking || item.streaming) && (
        <div className="think-body kids-in">
          <div className="think-scroll" ref={scrollRef}>{item.thinking || "…"}</div>
        </div>
      )}
    </>
  );
}
