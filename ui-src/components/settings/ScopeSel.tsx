// 设置页统一作用域下拉（profile / project 二级，全站唯一实现）：Profile 固定首项 + 工作区项目列表。
// 视觉与交互以技能页原实现为基准（.sel 胶囊 + .menu.scope-menu，点外部关闭、选中打勾、
// 图标随层级切换 scopeProfile/folder）。用户级 omp 不存在，只有 Profile 与项目两级。
// 样式基类 .scope-sel-btn 在 style.css 单点定义，各页禁止再写私有按钮类。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";

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
  // 点菜单外关闭（同各页原 document 级监听）
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const cur = value === profile.id ? profile : (projects.find((p) => p.id === value) ?? profile);
  const pick = (id: string) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setOpen(false);
    onChange(id);
  };
  return (
    <div className="sel scope-sel">
      <button type="button" className="scope-sel-btn" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="inline-flex items-center text-faint">
          <Icon name={cur.id === profile.id ? "scopeProfile" : "folder"} size={14} />
        </span>
        <span>{cur.label}</span>
        <span className="caret-svg"><Icon name="caret" size={14} /></span>
      </button>
      <div className={"menu scope-menu" + (open ? " open" : "")}>
        <div className="scope-menu-top">
          <div className="mi" data-scope={profile.id} onClick={pick(profile.id)}>
            <span className="ck" style={{ visibility: profile.id === value ? "visible" : "hidden" }}>✓</span>
            <Icon name="scopeProfile" size={14} />
            <span className="mi-label" title={profile.label}>{profile.label}</span>
          </div>
        </div>
        <div className="sep" />
        <div className="scope-menu-header">{t("settingsPage.scopeSel.workspace")}</div>
        <div className="scope-menu-projects">
          {projects.map((s) => (
            <div key={s.id} className="mi" data-scope={s.id} onClick={pick(s.id)}>
              <span className="ck" style={{ visibility: s.id === value ? "visible" : "hidden" }}>✓</span>
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
