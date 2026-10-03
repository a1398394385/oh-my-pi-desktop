// Model menu (ported from the old composer.js buildModelMenu + pickModel):
// the first level lists the user's custom model roles (a "Model Role" section
// pinned to the top, separated from providers by a divider) then providers
// (› indicator); hover 180ms intent delay / click pops the flyout to the
// right — a role row applies the role's resolved model through the host's CLI
// role path, a model row switches directly. The flyout renders as a direct
// child of #composer (fragment sibling slot; the old version attached to
// composerEl to dodge .menu.model's overflow-y:auto clipping); with a session
// it goes through the host set_model, in creating-new state it lands in
// localStorage.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pickModelId } from "../../store";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";
import type { ModelRoleEntry } from "../../types/frames";

// Flyout slot key for the custom-role group; "@"-prefixed on purpose so a
// custom role named like a provider can never collide with the provider keys
const ROLE_SECTION_KEY = "@roles";

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
  const modelRoles = useAppStore((st) => st.modelRoles);
  const cyclePreview = useAppStore((st) => st.cyclePreview);
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
  // Unmount timer cleanup; also drop ctrl+p preview state so a later
  // auto-close timer (keys.ts) cannot close a freshly manually opened menu
  useEffect(
    () => () => {
      clearTimeout(hideT.current ?? undefined);
      clearTimeout(switchT.current ?? undefined);
      if (useAppStore.getState().cyclePreview) useAppStore.setState({ cyclePreview: null });
    },
    [],
  );

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

  // Role picked: same routing, but the role id travels along so the host
  // applies the CLI role path (role-tracked model change + explicit role
  // thinking level)
  const pickRole = (role: ModelRoleEntry & { resolved: string }) => {
    pickModelId(role.resolved, role.id);
    onClose();
  };

  // Custom roles with a resolvable model (the "Model Role" section is hidden
  // entirely when none qualify)
  const customRoles = (modelRoles ?? []).filter(
    (r): r is ModelRoleEntry & { resolved: string } => !r.builtin && !!r.resolved,
  );

  // Group by provider (host-delivered ids look like "provider/modelId")
  const groups = new Map<string, [string, string][]>();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov)!.push([id, name]);
  }

  // ctrl+p preview mode: a transient flat list of exactly the cyclable roles
  // (cycleOrder resolution), the just-switched-to slot highlighted; rows stay
  // pickable. Auto-collapses from keys.ts (0.8s pause / Ctrl release)
  if (cyclePreview) {
    const modelName = (id: string): string =>
      modelNames.get(id) ?? (modelRoles ?? []).find((r) => r.resolved === id)?.resolvedName ?? id;
    return (
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        {cyclePreview.entries.map((en) => {
          const active = en.role === cyclePreview.activeRole && en.model === cyclePreview.activeModel;
          return (
            <div
              className={"mi" + (active ? " on" : "")}
              key={en.role}
              onClick={() => {
                pickModelId(en.model, en.role);
                onClose();
              }}
            >
              <span className="ck">{active ? "✓" : ""}</span>
              {en.role} : {modelName(en.model)}
            </div>
          );
        })}
      </div>
    );
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
        {customRoles.length > 0 && (
          <>
            <div
              className={"mi prov" + (ROLE_SECTION_KEY === flyProv ? " on" : "")}
              ref={(el) => { if (el) rowRefs.current.set(ROLE_SECTION_KEY, el); else rowRefs.current.delete(ROLE_SECTION_KEY); }}
              // Same hover-intent / click toggle semantics as the provider rows below
              onMouseEnter={() => {
                clearTimeout(hideT.current ?? undefined);
                if (ROLE_SECTION_KEY === flyProv) return;
                clearTimeout(switchT.current ?? undefined);
                switchT.current = setTimeout(() => setFlyProv(ROLE_SECTION_KEY), 180);
              }}
              onMouseLeave={() => clearTimeout(switchT.current ?? undefined)}
              onClick={(e) => {
                e.stopPropagation();
                clearTimeout(hideT.current ?? undefined);
                clearTimeout(switchT.current ?? undefined);
                setFlyProv(ROLE_SECTION_KEY === flyProv ? null : ROLE_SECTION_KEY);
              }}
            >
              {t("composer.modelRoleCategory")}
              <span className="sub"><Icon name="chevronRight" size={10} /></span>
            </div>
            <div className="sep" />
          </>
        )}
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
          {flyProv === ROLE_SECTION_KEY
            ? customRoles.map((role) => (
                <div className="mi" data-role={role.id} key={role.id} onClick={() => pickRole(role)}>
                  <span className="ck">{curModel === role.resolved ? "✓" : ""}</span>
                  {role.name} : {role.resolvedName ?? role.resolved}
                </div>
              ))
            : // When flyProv is truthy, groups always has that key (the grouping
              // is self-built); the ?? [] only satisfies strict typing
              (groups.get(flyProv) ?? []).map(([id, name]) => (
                <div className="mi" data-model={id} key={id} onClick={() => pickModel(id)}>
                  <span className="ck">{curModel === id ? "✓" : ""}</span>{name}
                </div>
              ))}
        </div>
      )}
    </>
  );
}
