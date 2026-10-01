// 设置·技能页（React 版）：多目录发现、启用开关、搜索、行内延展编辑。
// 逻辑 1:1 平移 ui/settings/skills.js；DOM 对照 git 464131d ui/index.html #pg-skills。
// 编辑器走 .mem-expand 向下延展模式（行 .on 高亮 + caret 旋转 + popIn）。
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import type { TimerHandle } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { ExtSourceTag, useExtSources } from "../ExtSourceTag";
import ScopeSel from "../ScopeSel";

// 技能条目（agent_assets 回包 skills 各目录列表项；host 下发）
interface SkillItem {
  name: string;
  path: string;
  enabled: boolean;
  description?: string;
  provider?: string; // 来源插件名；native 不显示
}

// 项目级技能分组（agentAssets.skills.projects 元素）
interface SkillProject {
  cwd: string;
  name: string;
  dir?: string;
  skills: SkillItem[];
}

// agentAssets.skills 下发结构（字段为 host 下发，缺省可空）
interface SkillsData {
  globalDir?: string;
  global?: SkillItem[];
  profile?: SkillItem[];
  profileName?: string;
  profileDir?: string;
  projects?: SkillProject[];
}

// 页面内派生的作用域分段
interface SkillSection {
  scope: string; // "profile" / "project:<cwd>"
  label: string;
  dir?: string;
  items: SkillItem[];
}

export default function SkillsPage() {
  const { t } = useTranslation();
  // 渲染数据走字段 selector：agentAssets / assetFile / assetFileSaved 落地帧均换新引用；
  // onToggle 乐观写也走 setState 换引用链（见 onToggle），字段订阅即可感知
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hostSettings = useAppStore((s) => s.hostSettings);
  // 技能总开关（底座 skills.enabled，缺省视为开启）；关闭时页面其余控件灰显禁用
  const skillsEnabled = hostSettings?.skillsEnabled !== false;
  const [scope, setScope] = useState("profile"); // "profile" / "project:<cwd>"
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false); // more 菜单
  const [spin, setSpin] = useState(false); // 刷新按钮旋转
  const [openPath, setOpenPath] = useState<string | null>(null); // 向下延展编辑的技能 path（null = 收起）
  const [editText, setEditText] = useState(""); // 编辑器内容（本地受控）
  const [editLoading, setEditLoading] = useState(false); // 等 asset_file 回包填内容
  const [editStatus, setEditStatus] = useState(""); // 保存中… / 已保存
  const seenStamp = useRef<unknown>(null); // 已消费的 asset_file_saved 回包（按引用判重）
  const statusTimer = useRef<TimerHandle | undefined>(undefined);
  useExtSources(); // 扩展中心全 scope 数据（行内来源徽标匹配用）

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(
    allProjects.filter((c) => !removedProjects.includes(c))
  );

  // ---------- 数据派生（同旧版 currentSkillSections/getActiveSkillSection） ----------
  const data: SkillsData | undefined = agentAssets?.skills as SkillsData | undefined; // frames 侧 skills 暂 unknown(host/assets.ts 内部扫描决定),本页按实际读取收窄
  const profileSec: SkillSection = {
    scope: "profile",
    label: `Profile · ${data?.profileName ?? "default"}`,
    dir: data?.profileDir,
    items: data?.profile || [],
  };
  const projectSecs: SkillSection[] = (data?.projects || [])
    .filter((p) => validProjectCwds.has(p.cwd))
    .map((p) => ({
      scope: `project:${p.cwd}`,
      label: p.name,
      dir: p.dir,
      items: p.skills || [],
    }));
  const sections: SkillSection[] = [profileSec, ...projectSecs];

  // 当前作用域失效时回落到 profile 级
  const curSec: SkillSection =
    sections.find((s) => s.scope === scope) || profileSec;

  const totalCount = curSec.items.length;
  const q = query.trim().toLowerCase();
  const filtered = curSec.items.filter((item) => !q || item.name.toLowerCase().includes(q) || (item.description && item.description.toLowerCase().includes(q)));

  // ---------- 全局点击关闭 more 菜单（作用域下拉由 ScopeSel 自管理；对应旧版 closeAllMenus） ----------
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [moreOpen]);

  // asset_file 回包：匹配当前延展区则填入编辑器
  const assetFile = useAppStore((s) => s.assetFile);
  useEffect(() => {
    if (openPath && editLoading && assetFile && assetFile.kind === "skill" && assetFile.path === openPath) {
      setEditText(assetFile.content ?? "");
      setEditLoading(false);
    }
  });

  // asset_file_saved 回包：延展区状态行「已保存」，2s 后清除
  const assetFileSaved = useAppStore((s) => s.assetFileSaved);
  useEffect(() => {
    const st = assetFileSaved;
    if (!st || st.kind !== "skill" || seenStamp.current === st) return;
    seenStamp.current = st; // 无论延展区是否还开着都记为已消费，防重放
    if (!openPath) return;
    setEditStatus(t("settingsPage.shared.saved"));
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setEditStatus(""), 2000);
  }, [assetFileSaved, openPath]);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  // ---------- 交互（1:1 平移旧版事件绑定） ----------
  function toggleSkills() {
    const next = !skillsEnabled;
    send({ type: "set_skills_enabled", enabled: next });
    toast(next ? t("settingsPage.skills.onToast") : t("settingsPage.skills.offToast"));
  }

  function toggleEditor(s: SkillItem) {
    if (openPath === s.path) { setOpenPath(null); return; } // 再点收起
    setOpenPath(s.path);
    setEditText(t("settingsPage.shared.reading"));
    setEditLoading(true);
    setEditStatus("");
    send({ type: "asset_file_read", kind: "skill", path: s.path });
  }

  function onToggle(item: SkillItem) {
    const next = !item.enabled;
    // 乐观换引用：拷贝 agentAssets → skills → item 所在段数组并替换该 item（字段写入即通知，统计/开关随重渲染刷新）
    const st = useAppStore.getState();
    const skills = st.agentAssets?.skills as SkillsData | undefined;
    const replace = (arr: SkillItem[]) => arr.map((x) => (x === item ? { ...item, enabled: next } : x));
    let nextSkills: SkillsData | undefined;
    if (skills?.global?.includes(item)) nextSkills = { ...skills, global: replace(skills.global) };
    else if (skills?.profile?.includes(item)) nextSkills = { ...skills, profile: replace(skills.profile) };
    else if (skills?.projects) {
      const proj = skills.projects.find((p) => p.skills.includes(item));
      if (proj) nextSkills = { ...skills, projects: skills.projects.map((p) => (p === proj ? { ...p, skills: replace(p.skills) } : p)) };
    }
    if (st.agentAssets && nextSkills) useAppStore.setState({ agentAssets: { ...st.agentAssets, skills: nextSkills } });
    send({ type: "asset_skill_toggle", name: item.name, enabled: next });
  }

  async function onRowDelete(s: SkillItem) {
    if (await confirmDialog({ title: t("settingsPage.skills.deleteTitle"), message: t("settingsPage.skills.deleteMsgThorough", { name: s.name }), confirmText: t("common.delete"), danger: true })) {
      send({ type: "asset_skill_delete", path: s.path });
    }
  }

  function onRefresh() {
    setSpin(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpin(false), 500);
  }

  function onMorePick(id: string) {
    setMoreOpen(false);
    if (id === "dir") {
      if (curSec.dir) send({ type: "open_folder", path: curSec.dir });
    } else if (id === "enableAll") {
      for (const s of curSec.items) if (!s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: true });
    } else if (id === "disableAll") {
      for (const s of curSec.items) if (s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: false });
    }
  }

  function onNew() {
    const name = window.prompt(t("settingsPage.skills.newPrompt"));
    if (!name || !name.trim()) return;
    const cleanName = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleanName)) {
      toast(t("settingsPage.skills.nameInvalid"));
      return;
    }
    const parts = curSec.scope.includes(":")
      ? { scope: curSec.scope.split(":")[0], cwd: curSec.scope.slice(curSec.scope.indexOf(":") + 1) }
      : { scope: curSec.scope };
    send({ type: "asset_file_create", kind: "skill", name: cleanName, ...parts });
  }

  function onSave() {
    if (!openPath) return;
    setEditStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_write", kind: "skill", path: openPath, content: editText });
  }

  async function onEditorDelete(s: SkillItem) {
    if (!openPath) return;
    if (await confirmDialog({ title: t("settingsPage.skills.deleteTitle"), message: t("settingsPage.skills.deleteMsgUndo", { name: s.name }), confirmText: t("common.delete"), danger: true })) {
      send({ type: "asset_skill_delete", path: openPath });
      setOpenPath(null); // 同旧版：确认后立即收起延展区
    }
  }

  return (
    <div className="set-page" id="pg-skills">
      <div className="skills-header">
        <div className="skills-tt">{t("settingsPage.nav.skills")}</div>
      </div>

      <div className="set-card" id="skillsMasterCard">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.skills.masterTitle")}</b>
            <span>{t("settingsPage.skills.masterDesc")}</span>
          </div>
          <div
            className={"tg" + (skillsEnabled ? " on" : "")}
            id="tgSkills"
            title={skillsEnabled ? t("settingsPage.skills.masterOn") : t("settingsPage.skills.masterOff")}
            onClick={toggleSkills}
          >
            <i></i>
          </div>
        </div>
      </div>

      <div className={skillsEnabled ? "" : "skills-off-dim"}>
      <div className="set-group-tt" id="skillsInstalledLabel">{t("settingsPage.skills.installedLabel")}</div>

      <div className="skills-bar">
        <div className="skills-scope-wrap">
          <ScopeSel
            value={scope}
            onChange={(id) => { setScope(id); setOpenPath(null); }}
            profile={{ id: profileSec.scope, label: profileSec.label }}
            projects={projectSecs.map((s) => ({ id: s.scope, label: s.label }))}
          />
          <span className="skills-divider">|</span>
          <span className="text-ui-base text-dim" id="skillsTotalCount">{t("settingsPage.skills.countLabel", { count: totalCount })}</span>
        </div>
        <div className="skills-actions-wrap">
          <div className="sel" id="skillsMoreSel">
            <button type="button" className="skills-btn-icon" id="skillsMoreBtn" title={t("settingsPage.shared.moreOptions")}
              onClick={(e) => { e.stopPropagation(); const was = moreOpen; setMoreOpen(!was); }}>
              <Icon name="dots" size={14} />
            </button>
            <div className={"menu" + (moreOpen ? " open" : "")} id="skillsMoreMenu">
              <div className="mi" id="miOpenSkillsDir" onClick={(e) => { e.stopPropagation(); onMorePick("dir"); }}>
                <span className="mi-icon"><Icon name="folder" size={14} /></span>
                <span className="mi-label">{t("settingsPage.skills.openDir")}</span>
              </div>
              <div className="sep" />
              <div className="mi" id="miEnableAllSkills" onClick={(e) => { e.stopPropagation(); onMorePick("enableAll"); }}>
                <span className="mi-icon"><Icon name="permDefault" size={14} /></span>
                <span className="mi-label">{t("settingsPage.skills.enableAll")}</span>
              </div>
              <div className="mi" id="miDisableAllSkills" onClick={(e) => { e.stopPropagation(); onMorePick("disableAll"); }}>
                <span className="mi-icon"><Icon name="shield" size={14} /></span>
                <span className="mi-label">{t("settingsPage.skills.disableAll")}</span>
              </div>
            </div>
          </div>
          <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} id="skillsRefreshBtn" title={t("settingsPage.model.refresh")} onClick={onRefresh}>
            <Icon name="refresh" size={17} />
          </button>
          <button type="button" className="skills-btn-new" id="skillsNewBtn" onClick={onNew}>
            <Icon name="plus" size={14} />
            <span>{t("settingsPage.shared.newBtn")}</span>
          </button>
        </div>
        <div className="skills-search-wrap">
          <span className="skills-search-icon"><Icon name="search" size={14} /></span>
          <input type="text" className="skills-search-input" id="skillsSearchInput" placeholder={t("settingsPage.skills.searchPlaceholder")} spellCheck={false} autoComplete="off"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpenPath(null); }} />
        </div>
      </div>

      <div className="skills-list-wrap">
        <div className="skills-card-list" id="skillsList">
          {!agentAssets
            ? emptyRow(t("common.loading"), "skill-empty-row")
            : filtered.length === 0
              ? emptyRow(q ? t("settingsPage.skills.emptySearch") : t("settingsPage.skills.emptyScope"), "skill-empty-row")
              : filtered.map((s) => (
                <Fragment key={s.path}>
                  <div className={"skill-item-row" + (openPath === s.path ? " on" : "")} data-path={s.path} data-name={s.name}
                    onClick={() => toggleEditor(s)}>
                    <div className="skill-badge"><Icon name="skills" size={14} /></div>
                    <div className="skill-info">
                      <div className="skill-title-row">
                        <span className="text-ui-base font-medium truncate text-text">{s.name}</span>
                        <ExtSourceTag
                          kind="skill"
                          name={s.name}
                          path={s.path}
                          fallback={s.provider && s.provider !== "native" ? <span className="skill-provider-tag">{s.provider}</span> : undefined}
                        />
                      </div>
                      <div className="skill-desc" title={s.description || s.name}>{s.description || t("settingsPage.skills.noDesc")}</div>
                    </div>
                    <div className="skill-controls">
                      <div className={"tg" + (s.enabled ? " on" : "")} title={s.enabled ? t("settingsPage.shared.enabledTip") : t("settingsPage.shared.disabledTip")}
                        onClick={(e) => { e.stopPropagation(); onToggle(s); }}>
                        <i />
                      </div>
                      <button type="button" className="skill-trash-btn" title={t("settingsPage.skills.deleteBtnTitle")}
                        onClick={(e) => { e.stopPropagation(); onRowDelete(s); }}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                    <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
                  </div>
                  {openPath === s.path && (
                    <div className="mem-expand">
                      <div className="mem-exp-head">
                        <span>{t("settingsPage.skills.editTitle")}</span>
                        <span className="sub">{s.path}</span>
                        <span className="sp" />
                        <button type="button" className="save-btn"
                          onClick={(e) => { e.stopPropagation(); setOpenPath(null); }}>{t("settingsPage.shared.collapse")}</button>
                      </div>
                      <div className="sem-body">
                        <textarea id="skEditText" spellCheck={false} placeholder={t("settingsPage.skills.editPlaceholder")}
                          value={editText} onChange={(e) => setEditText(e.target.value)}
                          onClick={(e) => e.stopPropagation()} />
                      </div>
                      <div className="sem-foot">
                        <span className="text-ui-sm text-dim">{editStatus}</span>
                        <span className="sp" />
                        <button type="button" className="confirm-btn danger" onClick={() => onEditorDelete(s)}>{t("common.delete")}</button>
                        <button type="button" className="confirm-btn" onClick={onSave}>{t("common.save")}</button>
                      </div>
                    </div>
                  )}
                </Fragment>
              ))}
        </div>
      </div>
      {/* 技能编辑：点击行向下延展编辑区（见上方 mem-expand） */}
      <SchemaRows sections={PAGE_PLACEMENT["pg-skills"]} />
      </div>
    </div>
  );
}
