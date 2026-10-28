// Thinking row: the thinking label always shows under any setting (uiPrefs.showThinking
// only decides the default expand state when streaming starts; the expand state is recorded
// on item.expanded and written by the store). Click the label row to expand/collapse
// think-body. Folding mid-stream is allowed: the scroll latch handles the height fight,
// and a user-folded block stays folded as new content arrives.
// Migrated from renderThink in ui/tool-labels.js; the original's viewport anchoring on
// expansion holds naturally under React — DOM node reuse + an unchanged scrollTop means
// "the clicked row does not move", and when glued to the bottom Chat's scroll effect pins it.
import { useEffect, useLayoutEffect, useRef } from "react";
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
  const [closing, close, liftRef] = useLift();
  const expandable = item.expandable || item.thinking;
  const open = !!item.expanded && !closing;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follow latch: true while the inner scroller sits at its bottom, cleared the moment the
  // user scrolls up. Read by the streaming follow below.
  const followRef = useRef(true);

  // think-scroll bottom blur release: add no-fade when scrolled to the bottom (or content
  // shorter than one screen) (scrolling duty is on the inner .think-scroll: the outer layer
  // keeps its natural height so the left vertical line never scrolls out of view)
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const sync = () => {
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
      sc.classList.toggle("no-fade", atBottom);
      followRef.current = atBottom;
    };
    sc.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    return () => sc.removeEventListener("scroll", sync);
  }, [open]);

  // Streaming follow: .think-scroll has its own overflow, so MessagePage's bottom pinning of
  // #stream never reaches it — a block expanded by default (Ctrl+T / showThinking) would freeze
  // on its first rows while the thinking text grows. Pin the tail before paint unless the user
  // scrolled up to read (followRef is re-armed by scrolling back to the bottom).
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (sc && item.streaming && followRef.current) sc.scrollTop = sc.scrollHeight;
  }, [item.thinking, item.streaming]);

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
        <Icon name="think" size={15} className="th-ic" />
        <span className="lbl">{item.text || t("chat.thinkingFallback")}</span>
        {expandable && (
          <span className={"th-more" + (open ? " open" : "")}>
            <Icon name="chevronRight" size={10} />
          </span>
        )}
      </div>
      {/* Body stays mounted while closing (gated on expanded alone, not the arrow's `open`) so useLift can animate its height before the commit unmounts it */}
      {(item.expanded || closing) && (item.thinking || item.streaming) && (
        <div ref={liftRef} className="think-body kids-in">
          <div className="think-scroll" ref={scrollRef}>{item.thinking || "…"}</div>
        </div>
      )}
    </>
  );
}
