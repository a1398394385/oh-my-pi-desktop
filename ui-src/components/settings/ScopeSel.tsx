// Unified settings-page scope dropdown (profile / project two levels, the sole implementation
// app-wide): Profile pinned as the first item + workspace project list.
// Visuals and interaction follow the skills page's original implementation (.sel capsule +
// .menu.scope-menu, click-outside close, checkmark on selection, icon switches per level
// between scopeProfile/folder). No user-level omp exists — only Profile and project levels.
// Base class .scope-sel-btn is defined once in style.css; pages must not write private button classes.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { claimDropdown, releaseDropdown } from "../../lib/dropdownExclusive";
import { anchorMenuToSelection, sizeTriggerToMenu } from "./common";

export interface ScopeSelOption {
  id: string; // "profile" | "project:<cwd>"
  label: string;
}

export default function ScopeSel({ value, onChange, profile, projects }: {
  value: string;
  onChange: (id: string) => void;
  profile: ScopeSelOption;
  projects: ScopeSelOption[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // In-place expansion, same treatment as the settings Sel (see anchorMenuToSelection).
  useLayoutEffect(() => {
    if (!open || !selRef.current || !menuRef.current) return;
    anchorMenuToSelection(selRef.current, menuRef.current);
  }, [open]);
  // Same width contract as Sel: the trigger holds the menu's width before it opens.
  useLayoutEffect(() => {
    if (selRef.current && menuRef.current) sizeTriggerToMenu(selRef.current, menuRef.current);
  });
  // Close on click outside the menu (same as each page's original document-level listener)
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      releaseDropdown(close);
    };
  }, [open]);
  const cur = value === profile.id ? profile : (projects.find((p) => p.id === value) ?? profile);
  const pick = (id: string) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setOpen(false);
    onChange(id);
  };
  return (
    <div className="sel sel-value scope-sel" ref={selRef}>
      <button type="button" className="scope-sel-btn" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="inline-flex items-center text-faint">
          <Icon name={cur.id === profile.id ? "scopeProfile" : "folder"} size={14} />
        </span>
        <span className="scope-sel-label">{cur.label}</span>
        <span className="caret-svg"><Icon name="caret" size={14} /></span>
      </button>
      <div className={"menu scope-menu" + (open ? " open" : "")} ref={menuRef}>
        <div className="scope-menu-top">
          <div className={"mi" + (profile.id === value ? " on" : "")} data-scope={profile.id} onClick={pick(profile.id)}>
            <span className="ck" style={{ visibility: profile.id === value ? "visible" : "hidden" }}><Icon name="check" size={14} /></span>
            <Icon name="scopeProfile" size={14} />
            <span className="mi-label" title={profile.label}>{profile.label}</span>
          </div>
        </div>
        <div className="sep" />
        <div className="scope-menu-header">{t("settingsPage.scopeSel.workspace")}</div>
        <div className="scope-menu-projects">
          {projects.map((s) => (
            <div key={s.id} className={"mi" + (s.id === value ? " on" : "")} data-scope={s.id} onClick={pick(s.id)}>
              <span className="ck" style={{ visibility: s.id === value ? "visible" : "hidden" }}><Icon name="check" size={14} /></span>
              <Icon name="folder" size={14} />
              <span className="mi-label" title={s.label}>{s.label}</span>
            </div>
          ))}
          {projects.length === 0 && <div className="mi empty disabled">{t("settingsPage.scopeSel.noProjects")}</div>}
        </div>
      </div>
    </div>
  );
}
