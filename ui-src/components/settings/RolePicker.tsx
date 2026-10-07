// Shared two-level cascade model picker. `ModelCascadePicker` is the generic
// interaction (trigger .sel + provider menu + hover flyout); `RolePicker` is the
// role-specific shell consumed by the Model page's chat-role editor (RolesView)
// and the Special features page — candidate filtering mirrors the base's
// roleCandidatePool. The keepalive targets picker (ExperimentalPage) consumes the
// generic picker directly.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore, send } from "../../store";
import { t } from "../../i18n";
import ModelCascadeMenu, { type PickerModel, type PickerRole } from "../shared/models/ModelCascadeMenu";
export type { PickerModel, PickerRole } from "../shared/models/ModelCascadeMenu";
import Icon from "../../Icon";
import { claimDropdown, releaseDropdown } from "../../lib/dropdownExclusive";

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

// Referenced role id extracted from a role value ("@smol", "@smol:high",
// legacy "pi/smol", "*" shorthand for default); null when the value names a
// concrete model. Mirrors the base resolver's alias prefixes.
export function referencedRoleId(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (s === "*") return "default";
  const m = /^@([A-Za-z0-9_-]+)/.exec(s) ?? /^pi\/([A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1] : null;
}

// Cycle guard for offering `selfId -> targetId` as a reference: walk the chain
// from target through each role's current @-reference; reaching selfId means
// the new wiring would loop (the base resolver breaks cycles by falling back
// to the built-in priority chain — better to not offer the row at all).
function referencesBackTo(roles: ReadonlyArray<ModelRole>, selfId: string, targetId: string): boolean {
  let cur: string | null = targetId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === selfId) return true;
    seen.add(cur);
    cur = referencedRoleId(roles.find((r) => r.id === cur)?.value);
  }
  return false;
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
  selectedRoleId,
  disabled,
  roles,
  roleLabel,
  // Rendered when both the candidate list and the role section are empty
  // (RolePicker passes a "no models" hint; keepalive's synthesized list never hits this)
  emptyContent,
  onPick,
  onPickRole,
}: {
  models: ReadonlyArray<PickerModel>;
  label: ReactNode;
  // Model id marked ✓ in the flyout (role value; keepalive adds nothing)
  selectedId?: string;
  // Role id marked ✓ in the roles flyout (role rows storing "@role" values)
  selectedRoleId?: string;
  disabled?: boolean;
  // Referenceable-role section above the provider cascade (settings role rows)
  roles?: ReadonlyArray<PickerRole>;
  roleLabel?: string;
  emptyContent?: ReactNode;
  onPick: (id: string) => void;
  onPickRole?: (role: PickerRole) => void;
}) {
  const [open, setOpen] = useState(false);
  // Level-1 menu flips upward when there is no room below the pill (role lists
  // taller than the settings scroll area) and more room above — .sel-up carries
  // the whole upward language including the caret rotation
  const [up, setUp] = useState(false);
  const selRef = useRef<HTMLDivElement>(null);
  // Close on click outside the selector (global equivalent of the old closeAllMenus)
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    const onDoc = (e: MouseEvent) => {
      if (!selRef.current?.contains(e.target as Node | null)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      releaseDropdown(close);
    };
  }, [open]);

  // Level-1 menu placement: defaults to the CSS "drop below" (.sel > .menu);
  // when the rendered menu overflows the settings scroll area's bottom edge,
  // flip to .sel-up (bottom-anchored) if more room remains above, otherwise cap
  // the height and scroll internally — same policy as the flyout below
  const positionMenu = (menu: HTMLDivElement) => {
    const sel = selRef.current;
    if (!sel) return;
    const z = useAppStore.getState().zoomLevel || 1;
    const bound = sel.closest("#setBody") ?? document.body;
    const selRect = sel.getBoundingClientRect();
    const boundRect = bound.getBoundingClientRect();
    const availBelow = Math.round((boundRect.bottom - selRect.bottom) / z) - 6;
    if (menu.offsetHeight <= availBelow) {
      setUp(false);
      return;
    }
    const availAbove = Math.round((selRect.top - boundRect.top) / z) - 6;
    setUp(availAbove > availBelow);
    menu.style.maxHeight = Math.max(80, Math.max(availAbove, availBelow)) + "px";
    menu.style.overflowY = "auto";
  };

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
      className={"sel mp-role-sel" + (disabled ? " disabled" : "") + (up ? " sel-up" : "")}
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
      {open && <ModelCascadeMenu models={models} selectedId={selectedId} selectedRoleId={selectedRoleId} onPick={pick}
        roles={roles} roleLabel={roleLabel} onPickRole={onPickRole} emptyContent={emptyContent}
        menuClassName="mp-role-menu" highlightSelected positionMenu={positionMenu} positionFlyout={positionFlyout} />}

    </div>
  );
}

/** Role row's picker: candidate filtering by the role's accepted kinds, value
 * display and write-back stay role-specific; the cascade interaction lives in
 * ModelCascadePicker. */
export function RolePicker({ role, allModels }: { role: ModelRole; allModels: CatalogModel[] }) {
  const modelRoles = useAppStore((s) => s.modelRoles);
  // Reference section: chat-section roles only (a kind role's value must expand to a
  // model its accepts() takes; cross-references would evade that), never the row
  // itself, and never a role whose current @-chain loops back to this row.
  const roleRefs =
    role.section === "kind"
      ? []
      : (modelRoles ?? [])
          .filter(
            (r) =>
              r.section !== "kind" &&
              r.id !== role.id &&
              !referencesBackTo(modelRoles ?? [], role.id, r.id),
          )
          .map((r) => ({
            id: r.id,
            name: r.name,
            // What the target currently resolves to ("Not set" when unconfigured)
            resolved: r.resolved ?? t("settingsPage.model.roleUnset"),
            resolvedName: r.resolvedName,
          }));
  return (
    <ModelCascadePicker
      models={allModels.filter((m) => roleAcceptsModel(role, m))}
      label={roleSelLabel(role)}
      selectedId={role.value ?? undefined}
      selectedRoleId={referencedRoleId(role.value) ?? undefined}
      roles={roleRefs}
      roleLabel={roleRefs.length > 0 ? t("settingsPage.model.roleRefGroup") : undefined}
      // Empty-state row shown when the role's kind filter leaves no candidates
      // (same .mi empty styling as the composer's no-models row)
      emptyContent={
        <div className="mi empty" style={{ color: "var(--dim)", cursor: "default", justifyContent: "center", padding: "8px 12px" }}>
          {t("settingsPage.cap.emptyModels")}
        </div>
      }
      onPick={(value) => {
        if ((role.value ?? null) !== value) send({ type: "set_model_role", role: role.id, value });
      }}
      onPickRole={(target) => {
        const value = `@${target.id}`;
        if (role.value !== value) send({ type: "set_model_role", role: role.id, value });
      }}
    />
  );
}
