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
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pickModelId } from "../../store";
import type { ModelCaps } from "../../store/models";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";
import ModelCascadeMenu, { type PickerRole } from "../shared/models/ModelCascadeMenu";
import type { ModelRoleEntry } from "../../types/frames";

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
  // Capability axes per model id (18.5 models frame; swaps reference with the catalog)
  const modelCaps = useAppStore((st) => st.modelCaps);
  const curModel = s?.model || newSessionModel;
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);
  // Unmount timer cleanup; also drop ctrl+p preview state so a later
  // auto-close timer (keys.ts) cannot close a freshly manually opened menu
  useEffect(
    () => () => {
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
  const positionFlyout = (menu: HTMLDivElement, fly: HTMLDivElement, row: HTMLDivElement) => {
    const comp = composerRef.current;
    if (!comp) return;
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
  };

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
  const pickRole = (role: PickerRole) => {
    pickModelId(role.resolved, role.id);
    onClose();
  };

  // Custom roles with a resolvable model (the "Model Role" section is hidden
  // entirely when none qualify)
  const customRoles = (modelRoles ?? []).filter(
    (r): r is ModelRoleEntry & { resolved: string } => !r.builtin && !!r.resolved,
  );

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
              <CapBadges caps={modelCaps.get(en.model)} />
            </div>
          );
        })}
      </div>
    );
  }

  return <ModelCascadeMenu
    models={[...modelNames].map(([id, name]) => ({ id, name, provider: id.split("/")[0] }))}
    selectedId={curModel ?? undefined} onPick={pickModel}
    roles={modelNames.size > 0 ? customRoles : []} roleLabel={t("composer.modelRoleCategory")} onPickRole={pickRole}
    renderModelMeta={(model) => <CapBadges caps={modelCaps.get(model.id)} />}
    emptyContent={<div className="mi empty" style={{ color: "var(--dim)", cursor: "default", justifyContent: "center", padding: "8px 12px" }}>{t("composer.noModels")}</div>}
    menuId="modelMenu" arrowSize={10}
    positionMenu={(menu) => placeComposerMenu(composerRef.current, menu, btnRef.current)}
    positionFlyout={positionFlyout}
  />;
}

// Capability badges at model-row tails (18.5 models frame axes): small text
// chips for prompt-cache keepalive / built-in web search / image generation;
// rendered only for axes the host actually reports
function CapBadges({ caps }: { caps: ModelCaps | undefined }) {
  const { t } = useTranslation();
  if (!caps) return null;
  const badges: string[] = [];
  if ((caps.promptCache ?? 0) > 0) badges.push(t("compExt.capCache"));
  if (caps.webSearch) badges.push(t("compExt.capWeb"));
  if (caps.imageGen) badges.push(t("compExt.capImg"));
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((label) => (
        <span className="cap-b" key={label}>{label}</span>
      ))}
    </>
  );
}
