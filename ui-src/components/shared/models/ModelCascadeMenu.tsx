import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Icon from "../../../Icon";

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
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const groups = new Map<string, PickerModel[]>();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider)!.push(model);
  }
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

  const providerRow = (key: string, label: ReactNode) => (
    <div className={"mi prov" + (group === key ? " on" : "")} key={key}
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
        clearTimeout(hideTimer.current);
        clearTimeout(switchTimer.current);
        setGroup(group === key ? null : key);
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
      {group === ROLE_GROUP ? roles.map((role) => <div className="mi" data-role={role.id} key={role.id}
        onClick={(e) => { e.stopPropagation(); onPickRole!(role); }}>
        <span className="ck">{selectedRoleId === role.id || selectedId === role.resolved ? "✓" : ""}</span>
        {role.name} : {role.resolvedName ?? role.resolved}
      </div>) : (groups.get(group) ?? []).map((model) => <div
        className={"mi" + (highlightSelected && selectedId === model.id ? " on" : "")}
        data-model={model.id} key={model.id} onClick={(e) => { e.stopPropagation(); onPick(model.id); }}>
        <span className="ck">{selectedId === model.id ? "✓" : ""}</span>{model.name}{renderModelMeta?.(model)}
      </div>)}
    </div>}
  </>;
}
