import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Icon from "../../../Icon";
import type { TimerHandle } from "../../../store";

export interface PickerModel {
  id: string;
  name: string;
  provider: string;
}

export interface PickerRole {
  id: string;
  name: string;
  resolved: string;
  resolvedName?: string | null;
}

interface Props {
  models: readonly PickerModel[];
  selectedId?: string;
  onPick: (id: string) => void;
  roles?: readonly PickerRole[];
  roleLabel?: ReactNode;
  onPickRole?: (role: PickerRole) => void;
  // Marks a role row ✓ by role id (settings role rows store "@role" values, not the
  // resolved model); falls back to the resolved-model match used by the composer menu
  selectedRoleId?: string;
  renderModelMeta?: (model: PickerModel) => ReactNode;
  emptyContent?: ReactNode;
  menuClassName?: string;
  menuId?: string;
  arrowSize?: number;
  highlightSelected?: boolean;
  positionMenu?: (menu: HTMLDivElement) => void;
  positionFlyout: (menu: HTMLDivElement, flyout: HTMLDivElement, row: HTMLDivElement) => void;
}

const ROLE_GROUP = "@roles";

// Controlled menu content: adapters own candidate filtering, RPC and geometry.
export default function ModelCascadeMenu({ models, selectedId, onPick, roles = [], roleLabel, onPickRole, selectedRoleId,
  renderModelMeta, emptyContent, menuClassName = "", menuId, arrowSize = 14, highlightSelected = false,
  positionMenu, positionFlyout }: Props) {
  const [group, setGroup] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const flyRows = useRef(new Map<string, HTMLDivElement>());
  const hideTimer = useRef<TimerHandle | undefined>(undefined);
  const switchTimer = useRef<TimerHandle | undefined>(undefined);
  // Keyboard cursor: g = the flyout it belongs to (null = level-1 row). A
  // level-2 cursor is revalidated against group, so a mouse-opened flyout
  // invalidates a stale one.
  const [hl, setHl] = useState<{ g: string | null; k: string } | null>(null);
  const hlK = hl !== null && (hl.g === null || hl.g === group) ? hl.k : null;
  const groups = new Map<string, PickerModel[]>();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider)!.push(model);
  }
  const openGroup = (k: string) => {
    clearTimeout(hideTimer.current);
    clearTimeout(switchTimer.current);
    setGroup(k);
  };
  const closeGroup = () => {
    clearTimeout(hideTimer.current);
    clearTimeout(switchTimer.current);
    setGroup(null);
  };
  const level1 = roles.length > 0 ? [ROLE_GROUP, ...groups.keys()] : [...groups.keys()];
  useEffect(() => () => {
    clearTimeout(hideTimer.current);
    clearTimeout(switchTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (menuRef.current) positionMenu?.(menuRef.current);
  }, [positionMenu]);
  useLayoutEffect(() => {
    const row = rows.current.get(group ?? "");
    if (menuRef.current && flyRef.current && row) positionFlyout(menuRef.current, flyRef.current, row);
  }, [group, models, positionFlyout]);

  // Keyboard: ↑/↓ move the cursor within the current level (wrap at the ends),
  // → opens the highlighted row's flyout, ← returns to level 1, Enter picks a
  // row or toggles a provider row. The listener lives on window's capture
  // phase for the whole mount lifetime: focus stays in the composer editor
  // (or the page) while the menu is open, so swallow the keys there — before
  // Lexical's caret / send handlers and the global bindings see them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      // A sigil-completion panel riding the same editor (palette / bash card)
      // owns the keys while open — yield, same rule as ComposerPlugin's
      // typeaheadOpenRef
      if (document.querySelector(".menu.palette.open")) return;
      const key = e.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      const fly =
        group === null ? []
        : group === ROLE_GROUP ? roles.map((r) => r.id)
        : (groups.get(group) ?? []).map((m) => m.id);
      const inFly = hlK !== null && fly.includes(hlK);
      const keys = inFly ? fly : level1;
      const at = hlK === null ? -1 : keys.indexOf(hlK);
      switch (key) {
        case "ArrowUp":
        case "ArrowDown": {
          const d = key === "ArrowDown" ? 1 : -1;
          if (keys.length > 0) {
            const next = at < 0 ? keys[d < 0 ? keys.length - 1 : 0] : keys[(at + d + keys.length) % keys.length];
            setHl({ g: inFly ? group : null, k: next });
          }
          break;
        }
        case "ArrowRight":
          if (!inFly && hlK !== null && group !== hlK) {
            openGroup(hlK);
            setHl({ g: hlK, k: hlK === ROLE_GROUP ? roles[0].id : (groups.get(hlK) ?? [])[0].id });
          }
          break;
        case "ArrowLeft":
          if (inFly && group !== null) {
            closeGroup();
            setHl({ g: null, k: group });
          }
          break;
        case "Enter":
          if (inFly && group !== null) {
            if (group === ROLE_GROUP) {
              const role = roles.find((r) => r.id === hlK);
              if (role) onPickRole?.(role);
            } else {
              const model = (groups.get(group) ?? []).find((m) => m.id === hlK);
              if (model) onPick(model.id);
            }
          } else if (hlK !== null && group !== hlK) {
            openGroup(hlK);
          } else if (hlK !== null) {
            closeGroup();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [group, hlK, models, roles, onPick, onPickRole]);

  // Keep the cursor row inside its own scrollport (block:"nearest" never jumps
  // ancestor scrollers — same as the palette menus)
  useLayoutEffect(() => {
    if (hlK === null) return;
    const el = hl !== null && hl.g === null ? rows.current.get(hlK) : flyRows.current.get(hlK);
    el?.scrollIntoView({ block: "nearest" });
  }, [hl, hlK]);

  const providerRow = (key: string, label: ReactNode) => (
    <div className={"mi prov" + (group === key || hlK === key ? " on" : "")} key={key}
      ref={(el) => { if (el) rows.current.set(key, el); else rows.current.delete(key); }}
      onMouseEnter={() => {
        clearTimeout(hideTimer.current);
        if (key === group) return;
        clearTimeout(switchTimer.current);
        switchTimer.current = setTimeout(() => setGroup(key), 180);
      }}
      onMouseLeave={() => clearTimeout(switchTimer.current)}
      onClick={(e) => {
        e.stopPropagation();
        if (group === key) closeGroup();
        else openGroup(key);
      }}>
      {label}<span className="sub"><Icon name="chevronRight" size={arrowSize} /></span>
    </div>
  );
  return <>
    <div className={"menu model open " + menuClassName} id={menuId} ref={menuRef}>
      {roles.length > 0 && <>{providerRow(ROLE_GROUP, roleLabel)}<div className="sep" /></>}
      {[...groups.keys()].map((provider) => providerRow(provider, provider))}
      {models.length === 0 && roles.length === 0 && emptyContent}
    </div>
    {group && <div className="menu flyout open" ref={flyRef}
      onMouseEnter={() => { clearTimeout(hideTimer.current); clearTimeout(switchTimer.current); }}
      onMouseLeave={() => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setGroup(null), 150);
      }}>
      {group === ROLE_GROUP ? roles.map((role) => <div className={"mi" + (hlK === role.id ? " on" : "")} data-role={role.id} key={role.id}
        ref={(el) => { if (el) flyRows.current.set(role.id, el); else flyRows.current.delete(role.id); }}
        onClick={(e) => { e.stopPropagation(); onPickRole!(role); }}>
        <span className="ck">{selectedRoleId === role.id || selectedId === role.resolved ? "✓" : ""}</span>
        {role.name} : {role.resolvedName ?? role.resolved}
      </div>) : (groups.get(group) ?? []).map((model) => <div
        className={"mi" + (hlK === model.id || (highlightSelected && selectedId === model.id) ? " on" : "")}
        data-model={model.id} key={model.id}
        ref={(el) => { if (el) flyRows.current.set(model.id, el); else flyRows.current.delete(model.id); }}
        onClick={(e) => { e.stopPropagation(); onPick(model.id); }}>
        <span className="ck">{selectedId === model.id ? "✓" : ""}</span>{model.name}{renderModelMeta?.(model)}
      </div>)}
    </div>}
  </>;
}
