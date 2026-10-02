// Model menu (ported from the old composer.js buildModelMenu + pickModel):
// the first level lists providers (› indicator); hover 180ms intent delay /
// click pops the provider's model flyout to the right.
// The flyout renders as a direct child of #composer (fragment sibling slot;
// the old version attached to composerEl to dodge .menu.model's
// overflow-y:auto clipping); with a session it goes through the host set_model,
// in creating-new state it lands in localStorage.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pickModelId } from "../../store";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";

type ModelMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ModelMenu({ btnRef, composerRef, onClose }: ModelMenuProps) {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const modelNames = useAppStore((st) => st.modelNames);
  const curModel = s?.model || newSessionModel;
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>()); // prov -> provider row element (for flyout alignment)
  const [flyProv, setFlyProv] = useState<string | null>(null); // provider of the current second-level flyout
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null); // flyout close grace period
  const switchT = useRef<ReturnType<typeof setTimeout> | null>(null); // row-switch hover intent delay

  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  // Unmount timer cleanup
  useEffect(() => () => { clearTimeout(hideT.current ?? undefined); clearTimeout(switchT.current ?? undefined); }, []);

  // Flyout coordinates: #composer-relative (offsetParent). The second-level
  // list expands upward -- bottom edge aligned to the provider row's bottom
  // edge (both menus have 5px padding; +5 keeps the last row aligned with row
  // height), never stretching past the window's bottom edge; when the space
  // above is insufficient, cap height + internal scrolling with the top edge at
  // most 4px below the viewport top. Subtract scrollTop when the menu
  // scrolls. Do not clamp to 0: when the menu sticks out above the composer
  // carousel-style, offsetTop is negative and the flyout must follow the row
  // above the composer; clamping would slide the whole flyout out of place.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const comp = composerRef.current;
    const row = rowRefs.current.get(flyProv ?? "");
    const fly = flyRef.current;
    if (!menu || !comp || !row || !fly || !flyProv) return;
    const z = useAppStore.getState().zoomLevel || 1;
    fly.style.maxHeight = "";
    fly.style.overflowY = "";
    const rowBottom = menu.offsetTop + row.offsetTop - menu.scrollTop + row.offsetHeight;
    fly.style.top = "auto";
    fly.style.bottom = comp.clientHeight - rowBottom - 5 + "px";
    const availAbove = Math.round((comp.getBoundingClientRect().top - 4) / z) + rowBottom + 5;
    if (fly.offsetHeight > availAbove) {
      fly.style.maxHeight = Math.max(80, availAbove) + "px";
      fly.style.overflowY = "auto";
    }
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px"; // overlap the first-level menu's border by 4px, visually seamless
    if (fly.getBoundingClientRect().right > window.innerWidth - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px"; // right edge overflows: flip left
    }
  }, [flyProv]);

  // Model picked: with a session it goes through the host; creating-new state
  // lands in localStorage (a manual pick is no longer overridden by the config
  // default)
  const pickModel = (id: string) => {
    pickModelId(id);
    onClose();
  };

  // Group by provider (host-delivered ids look like "provider/modelId")
  const groups = new Map<string, [string, string][]>();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov)!.push([id, name]);
  }

  if (modelNames.size === 0) {
    return (
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        <div className="mi empty" style={{ color: "var(--dim)", cursor: "default", justifyContent: "center", padding: "8px 12px" }}>
          {t("composer.noModels")}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        {[...groups].map(([prov]) => (
          <div
            className={"mi prov" + (prov === flyProv ? " on" : "")}
            key={prov}
            ref={(el) => { if (el) rowRefs.current.set(prov, el); else rowRefs.current.delete(prov); }}
            // Row switch adds a 180ms hover intent delay: the pointer cutting
            // diagonally through middle rows toward the flyout does not steal
            // focus (the flyout's mouseenter cancels the pending switch);
            // dwelling long enough switches the provider; clicking still
            // expands/collapses immediately
            onMouseEnter={() => {
              clearTimeout(hideT.current ?? undefined);
              if (prov === flyProv) return;
              clearTimeout(switchT.current ?? undefined);
              switchT.current = setTimeout(() => setFlyProv(prov), 180);
            }}
            onMouseLeave={() => clearTimeout(switchT.current ?? undefined)}
            onClick={(e) => {
              e.stopPropagation();
              clearTimeout(hideT.current ?? undefined);
              clearTimeout(switchT.current ?? undefined);
              setFlyProv(prov === flyProv ? null : prov);
            }}
          >
            {prov}
            <span className="sub"><Icon name="chevronRight" size={10} /></span>
          </div>
        ))}
      </div>
      {flyProv && (
        <div
          className="menu flyout open"
          ref={flyRef}
          onMouseEnter={() => { clearTimeout(hideT.current ?? undefined); clearTimeout(switchT.current ?? undefined); }}
          onMouseLeave={() => {
            clearTimeout(hideT.current ?? undefined);
            hideT.current = setTimeout(() => setFlyProv(null), 150);
          }}
        >
          {/* When flyProv is truthy, groups always has that key (the grouping
              is self-built); the ?? [] only satisfies strict typing */}
          {(groups.get(flyProv) ?? []).map(([id, name]) => (
            <div className="mi" data-model={id} key={id} onClick={() => pickModel(id)}>
              <span className="ck">{curModel === id ? "✓" : ""}</span>{name}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
