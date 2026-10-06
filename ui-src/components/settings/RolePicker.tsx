// Shared two-level cascade model picker. `ModelCascadePicker` is the generic
// interaction (trigger .sel + provider menu + hover flyout); `RolePicker` is the
// role-specific shell consumed by the Model page's chat-role editor (RolesView)
// and the Special features page — candidate filtering mirrors the base's
// roleCandidatePool. The keepalive targets picker (ExperimentalPage) consumes the
// generic picker directly.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore, send } from "../../store";
import { t } from "../../i18n";
import ModelCascadeMenu, { type PickerModel } from "../shared/models/ModelCascadeMenu";
export type { PickerModel } from "../shared/models/ModelCascadeMenu";
import Icon from "../../Icon";

// Catalog model entry (modelCatalog field, landed from the models_catalog reply; fields sent by host)
export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  // Catalog kind (host modelCatalog; absent in older frames = chat, the catalog default)
  kind?: string;
  // Native/delegated web-search grounding axis (sent only when true); gates chat models in the WEB role menu
  webSearch?: boolean;
  context?: number | null;
  vision?: boolean;
  authSource?: string; // "cred" stored credential / "config" hand-written in models.yml
}

// (role pickers) and synthesized entries (keepalive: composer-menu modelNames) both fit

// Model role entry (modelRoles field)
export interface ModelRole {
  id: string;
  name: string;
  tag?: string | null; // host ModelRoleEntry is string | null
  value?: string | null; // unconfigured is null/absent
  section?: string; // "chat" | "kind" per the base's role metadata; kind roles live on the capability page
}

// Model kinds accepted per non-chat role (mirrors the base MODEL_ROLES accepts functions in
// pi-coding-agent config/model-roles.ts). Roles absent here (chat roles and user-defined custom
// roles) accept chat models only, matching the base getRoleInfo fallback.
const ROLE_KINDS: Record<string, string[]> = {
  tiny: ["tiny", "chat"],
  memory: ["tiny", "chat"],
  image: ["image"],
  // search backends, or chat models with web-search grounding (gated on the webSearch axis below)
  web: ["search", "chat"],
  speech: ["tts"],
  dictation: ["stt"],
  judge: ["judge", "tiny", "chat"],
};

// Whether a catalog model is a valid candidate for a role row's picker (same predicate as the
// base's roleCandidatePool filter; the host re-validates on write via the role's accepts())
export function roleAcceptsModel(role: ModelRole, m: CatalogModel): boolean {
  const kind = m.kind ?? "chat";
  if (!(ROLE_KINDS[role.id] ?? ["chat"]).includes(kind)) return false;
  return role.id !== "web" || kind !== "chat" || !!m.webSearch;
}

// Current value display of the role selector: unconfigured → "default"; exact catalog model hit → model name; otherwise (alias / level-suffixed) → raw value
export function roleSelLabel(role: ModelRole): string {
  if (!role.value) return role.id === "default" ? t("settingsPage.model.roleUnset") : t("settingsPage.model.roleDefault");
  const hit = useAppStore.getState().modelCatalog.find((m) => m.id === role.value);
  if (hit) return hit.name;
  return role.value;
}

/**
 * Generic two-level cascade picker: level-1 provider rows + hover right flyout,
 * interaction aligned with the composer model menu (180ms hover-intent delay /
 * 150ms grace close / flip left on right-edge overflow). The flyout is mounted
 * under .sel rather than inside the level-1 menu — .menu.model carries
 * overflow-y:auto which would clip absolutely positioned children. Widths
 * unified by .mp-role-sel / .mp-role-menu. `models` is the already-filtered
 * candidate list; provider grouping happens here.
 */
export function ModelCascadePicker({
  models,
  label,
  selectedId,
  disabled,
  onPick,
}: {
  models: ReadonlyArray<PickerModel>;
  label: ReactNode;
  // Model id marked ✓ in the flyout (role value; keepalive adds nothing)
  selectedId?: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selRef = useRef<HTMLDivElement>(null);

  // Close on click outside the selector (global equivalent of the old closeAllMenus)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!selRef.current?.contains(e.target as Node | null)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Flyout coordinates: relative to .sel (offsetParent). The level-2 list defaults to opening upward —
  // bottom edge aligned with the provider row's bottom edge
  // (both menus pad 5px; +5 aligns the last row with the row height), so it never pushes past
  // the settings scroll area's bottom; when space above is insufficient, flip to top-anchored
  // growing downward if more room remains below (long model lists stay visible instead of
  // clamping to a few rows), capping height + scrolling internally on the tighter side;
  // the flyout overlaps the level-1 menu border by 4px and flips left on right-edge overflow.
  const positionFlyout = (menu: HTMLDivElement, fly: HTMLDivElement, row: HTMLDivElement) => {
    const sel = selRef.current;
    if (!sel) return;
    const z = useAppStore.getState().zoomLevel || 1;
    fly.style.maxHeight = "";
    fly.style.overflowY = "";
    const rowTop = menu.offsetTop + row.offsetTop - menu.scrollTop;
    const rowBottom = rowTop + row.offsetHeight;
    fly.style.top = "auto";
    fly.style.bottom = sel.clientHeight - rowBottom - 5 + "px";
    const bound = sel.closest("#setBody") ?? document.body;
    const boundRect = bound.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const availAbove = Math.round((rowRect.bottom - boundRect.top) / z) - 4;
    const availBelow = Math.round((boundRect.bottom - rowRect.top) / z) - 4;
    if (fly.offsetHeight > availAbove) {
      if (availBelow > availAbove) {
        // Not enough room above: anchor the flyout's top at the provider row's top and grow down
        fly.style.bottom = "auto";
        fly.style.top = rowTop - 5 + "px";
        fly.style.maxHeight = Math.max(80, availBelow) + "px";
      } else {
        fly.style.maxHeight = Math.max(80, availAbove) + "px";
      }
      fly.style.overflowY = "auto";
    }
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px";
    if (fly.getBoundingClientRect().right > boundRect.right - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px";
    }
  };

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
  };

  return (
    <div
      className={"sel mp-role-sel" + (disabled ? " disabled" : "")}
      role="button"
      ref={selRef}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span>{label}</span>
      <span className="caret-svg"><Icon name="caret" size={14} /></span>
      {open && <ModelCascadeMenu models={models} selectedId={selectedId} onPick={pick}
        menuClassName="mp-role-menu" highlightSelected positionFlyout={positionFlyout} />}

    </div>
  );
}

/** Role row's picker: candidate filtering by the role's accepted kinds, value
 * display and write-back stay role-specific; the cascade interaction lives in
 * ModelCascadePicker. */
export function RolePicker({ role, allModels }: { role: ModelRole; allModels: CatalogModel[] }) {
  return (
    <ModelCascadePicker
      models={allModels.filter((m) => roleAcceptsModel(role, m))}
      label={roleSelLabel(role)}
      selectedId={role.value ?? undefined}
      onPick={(value) => {
        if ((role.value ?? null) !== value) send({ type: "set_model_role", role: role.id, value });
      }}
    />
  );
}
