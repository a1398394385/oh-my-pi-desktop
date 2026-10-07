// Shared model-picker family: the two-level cascade interaction extracted from the
// composer model menu (ui-src/components/composer/ModelMenu.tsx) plus the settings
// picker shell extracted from the old RolePicker's ModelCascadePicker.
// - useCascadeFlyout: hover-cascade state machine (180ms row-switch hover intent /
//   150ms flyout grace close) shared by the composer model menu and the pickers here.
// - EnabledModelPicker ("enabled-model selector"): candidate pool = host-enabled chat
//   models (modelNames frame + capability badges). `exclude` hides already-picked ids
//   (keepalive targets); `pinnedRows` mounts a flat first-level section above the
//   provider cascade (the quick-switch add dropdown lists addable chat roles there —
//   omit `onPick` for a pinned-only dropdown with no model cascade).
// - ConfiguredModelPicker ("configured-model selector"): candidate pool = the
//   configured model catalog (modelCatalog frame, disabled entries included — role
//   values may point at a disabled catalog entry), narrowed by a caller filter.
// Placement stays per-surface: the composer menu keeps its own #composer coordinate
// math; the pickers here share the settings placement (menu drops under the .sel
// trigger via CSS, flyout bounded by #setBody, flip-down when more room remains below).
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";
import type { TimerHandle } from "../store";
import type { ModelCaps } from "../store/models";
import Icon from "../Icon";
import { claimDropdown, releaseDropdown } from "../lib/dropdownExclusive";

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

// Flyout model row shape: enabled-pool rows carry the capability axes from the models frame
export type CascadeModel = { id: string; name: string; provider: string; caps?: ModelCaps };

// Flat first-level row pinned above the provider cascade (quick-switch add lists addable roles)
export type PinnedRow = { key: string; label: ReactNode; sub?: ReactNode; onPick: () => void };

/**
 * Two-level cascade state machine, extracted from the composer model menu:
 * provider-row switch carries a 180ms hover-intent delay (the pointer cutting
 * diagonally through middle rows toward the flyout does not steal focus; dwelling
 * long enough switches the provider; clicking still expands/collapses immediately),
 * the flyout closes with a 150ms grace period after mouseleave.
 */
export function useCascadeFlyout() {
  const [flyProv, setFlyProv] = useState<string | null>(null); // provider key of the current level-2 flyout
  const hideT = useRef<TimerHandle | undefined>(undefined); // flyout close grace
  const switchT = useRef<TimerHandle | undefined>(undefined); // row-switch hover-intent delay
  useEffect(() => () => { clearTimeout(hideT.current); clearTimeout(switchT.current); }, []);

  const clearTimers = () => {
    clearTimeout(hideT.current);
    clearTimeout(switchT.current);
  };

  // Spread onto a level-1 provider(-like) row
  const provRowProps = (key: string) => ({
    onMouseEnter: () => {
      clearTimeout(hideT.current);
      if (key === flyProv) return;
      clearTimeout(switchT.current);
      switchT.current = setTimeout(() => setFlyProv(key), 180);
    },
    onMouseLeave: () => clearTimeout(switchT.current),
    onClick: (e: ReactMouseEvent) => {
      e.stopPropagation();
      clearTimers();
      setFlyProv(key === flyProv ? null : key);
    },
  });

  // Spread onto the flyout itself
  const flyoutProps = {
    onMouseEnter: clearTimers,
    onMouseLeave: () => {
      clearTimeout(hideT.current);
      hideT.current = setTimeout(() => setFlyProv(null), 150);
    },
  };

  return { flyProv, setFlyProv, provRowProps, flyoutProps, clearTimers };
}

// Capability badges at model-row tails (18.5 models frame axes): small text chips
// for prompt-cache keepalive / built-in web search / image generation; rendered
// only for axes the host actually reports
export function CapBadges({ caps }: { caps: ModelCaps | undefined }) {
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

// Flyout model row: check mark + display name (+ capability badges when the pool
// carries them). `highlight` adds the settings-menu .on background (the composer
// menu marks the current model with the check only)
function ModelRow({
  m, selectedId, highlight, onPick,
}: {
  m: CascadeModel;
  selectedId?: string;
  highlight?: boolean;
  onPick: (id: string) => void;
}) {
  const on = selectedId === m.id;
  return (
    <div
      className={"mi" + (highlight && on ? " on" : "")}
      data-model={m.id}
      key={m.id}
      onClick={(e) => { e.stopPropagation(); onPick(m.id); }}
    >
      <span className="ck">{on ? "✓" : ""}</span>{m.name}
      <CapBadges caps={m.caps} />
    </div>
  );
}

// Group a model pool by provider (host-delivered ids look like "provider/modelId")
function groupByProvider<T extends { provider: string }>(models: ReadonlyArray<T>): Map<string, T[]> {
  const byProv = new Map<string, T[]>();
  for (const m of models) {
    if (!byProv.has(m.provider)) byProv.set(m.provider, []);
    byProv.get(m.provider)!.push(m); // the has() on the previous line guarantees the group exists
  }
  return byProv;
}

/**
 * Settings-surface picker shell: .sel trigger + level-1 menu (pinned rows above the
 * provider cascade) + hover flyout. The flyout is mounted under .sel rather than
 * inside the level-1 menu — .menu.model carries overflow-y:auto which would clip
 * absolutely positioned children. Widths unified by .mp-role-sel / .mp-role-menu.
 */
function SettingsCascadePicker({
  label, disabled, selClassName, menuClassName, pinnedRows, models, selectedId, emptyText, onPick,
}: {
  label: ReactNode;
  disabled?: boolean;
  selClassName?: string;
  // Level-1 menu base classes; default is the settings cascade look, overridable for flat dropdowns
  menuClassName?: string;
  pinnedRows?: ReadonlyArray<PinnedRow>;
  models: ReadonlyArray<CascadeModel>;
  // Model id marked ✓ in the flyout (role value; keepalive adds nothing)
  selectedId?: string;
  // Row shown when the menu has no rows at all (quick-switch "nothing left to add")
  emptyText?: ReactNode;
  // Model-row pick handler; omitted = no provider cascade (pinned-only dropdown)
  onPick?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { flyProv, setFlyProv, provRowProps, flyoutProps, clearTimers } = useCascadeFlyout();
  const selRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>()); // prov -> provider row element (for flyout top alignment)

  // Close on click outside the selector (global equivalent of the old closeAllMenus)
  useEffect(() => {
    if (!open) return undefined;
    const close = () => {
      clearTimers();
      setOpen(false);
      setFlyProv(null);
    };
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

  // Flyout coordinates: relative to .sel (offsetParent). The level-2 list defaults to opening upward —
  // bottom edge aligned with the provider row's bottom edge
  // (both menus pad 5px; +5 aligns the last row with the row height), so it never pushes past
  // the settings scroll area's bottom; when space above is insufficient, flip to top-anchored
  // growing downward if more room remains below (long model lists stay visible instead of
  // clamping to a few rows), capping height + scrolling internally on the tighter side;
  // the flyout overlaps the level-1 menu border by 4px and flips left on right-edge overflow.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const sel = selRef.current;
    const fly = flyRef.current;
    if (!menu || !sel || !fly || !flyProv) return;
    const row = rowRefs.current.get(flyProv);
    if (!row) return;
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
  }, [flyProv, open]);

  const groups = onPick ? groupByProvider(models) : null;
  const activeRows = groups?.get(flyProv ?? "");
  const menuEmpty = !groups && (!pinnedRows || pinnedRows.length === 0);

  const pick = (id: string) => {
    onPick?.(id);
    setOpen(false);
    setFlyProv(null);
  };

  return (
    <div
      className={"sel mp-role-sel" + (disabled ? " disabled" : "") + (selClassName ? " " + selClassName : "")}
      role="button"
      ref={selRef}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen((v) => !v);
        if (open) setFlyProv(null);
      }}
    >
      <span>{label}</span>
      <span className="caret-svg"><Icon name="caret" size={14} /></span>
      {open && (
        <div className={(menuClassName ?? "menu model mp-role-menu") + " open"} ref={menuRef}>
          {pinnedRows?.map((r) => (
            <div
              className="mi"
              key={r.key}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                setFlyProv(null);
                r.onPick();
              }}
            >
              <span className="mi-label">{r.label}</span>
              {r.sub !== undefined ? <span className="sub">{r.sub}</span> : null}
            </div>
          ))}
          {groups &&
            [...groups].map(([prov]) => (
              <div
                className={"mi prov" + (prov === flyProv ? " on" : "")}
                key={prov}
                ref={(el) => { if (el) rowRefs.current.set(prov, el); else rowRefs.current.delete(prov); }}
                {...provRowProps(prov)}
              >
                {prov}
                <span className="sub"><Icon name="chevronRight" size={14} /></span>
              </div>
            ))}
          {menuEmpty && emptyText !== undefined ? <div className="mi empty disabled">{emptyText}</div> : null}
        </div>
      )}
      {activeRows && onPick && (
        <div className="menu flyout open" ref={flyRef} {...flyoutProps}>
          {activeRows.map((m) => (
            <ModelRow key={m.id} m={m} selectedId={selectedId} highlight onPick={pick} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Enabled-model selector: pool = host-enabled chat models (modelNames frame — the
 * same content as the composer model menu; synthetic providers (local/web) and
 * non-chat kinds never list here), rows carrying capability badges. `exclude`
 * hides already-picked ids; `pinnedRows` mounts a flat first-level section above
 * the provider cascade (quick-switch add lists addable chat roles there — omit
 * `onPick` for a pinned-only dropdown with no model cascade).
 */
export function EnabledModelPicker({
  label, selectedId, exclude, disabled, pinnedRows, emptyText, onPick, selClassName, menuClassName,
}: {
  label: ReactNode;
  selectedId?: string;
  exclude?: ReadonlyArray<string>;
  disabled?: boolean;
  pinnedRows?: ReadonlyArray<PinnedRow>;
  emptyText?: ReactNode;
  onPick?: (id: string) => void;
  selClassName?: string;
  menuClassName?: string;
}) {
  const modelNames = useAppStore((s) => s.modelNames);
  const modelCaps = useAppStore((s) => s.modelCaps);
  const models: CascadeModel[] = [];
  if (onPick) {
    for (const [id, name] of modelNames) {
      if (exclude?.includes(id)) continue;
      models.push({ id, name, provider: id.split("/")[0], caps: modelCaps.get(id) });
    }
  }
  return (
    <SettingsCascadePicker
      label={label}
      disabled={disabled}
      selClassName={selClassName}
      menuClassName={menuClassName}
      pinnedRows={pinnedRows}
      models={models}
      selectedId={selectedId}
      emptyText={emptyText}
      onPick={onPick}
    />
  );
}

/**
 * Configured-model selector: pool = the configured model catalog (modelCatalog
 * frame, disabled entries included — role values may point at a disabled catalog
 * entry), narrowed by `filter` (role accepted kinds / chat-only creation form).
 */
export function ConfiguredModelPicker({
  label, selectedId, filter, disabled, onPick, selClassName,
}: {
  label: ReactNode;
  selectedId?: string;
  filter?: (m: CatalogModel) => boolean;
  disabled?: boolean;
  onPick: (id: string) => void;
  selClassName?: string;
}) {
  const modelCatalog = useAppStore((s) => s.modelCatalog);
  const models = modelCatalog.filter((m) => !filter || filter(m));
  return (
    <SettingsCascadePicker
      label={label}
      disabled={disabled}
      selClassName={selClassName}
      models={models}
      selectedId={selectedId}
      onPick={onPick}
    />
  );
}
