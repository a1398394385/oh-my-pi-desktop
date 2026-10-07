// Settings · Skills page (React version): multi-directory discovery, enable toggles, search,
// inline expand-down editing.
// Logic ported 1:1 from ui/settings/skills.js; DOM cross-check git 464131d ui/index.html #pg-skills.
// The editor uses the .mem-expand expand-down pattern (row .on highlight + caret rotation + popIn).
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import type { TimerHandle } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { ExtSourceTag, useExtSources, refreshExtSources } from "../ExtSourceTag";
import ScopeSel from "../ScopeSel";

// Skill entry (list item of each directory under skills in the agent_assets reply; sent by host)
interface SkillItem {
  name: string;
  path: string;
  enabled: boolean;
  description?: string;
  provider?: string; // source plugin name; hidden for native
}

// Project-level skill group (element of agentAssets.skills.projects)
interface SkillProject {
  cwd: string;
  name: string;
  dir?: string;
  skills: SkillItem[];
}

// Delivered structure under agentAssets.skills (fields sent by host, may be absent)
interface SkillsData {
  globalDir?: string;
  global?: SkillItem[];
  profile?: SkillItem[];
  profileName?: string;
  profileDir?: string;
  projects?: SkillProject[];
}

// Scope section derived in-page
interface SkillSection {
  scope: string; // "profile" / "project:<cwd>"
  label: string;
  dir?: string;
  items: SkillItem[];
}

export default function SkillsPage() {
  const { t } = useTranslation();
  // Render data via field selectors: agentAssets / assetFile / assetFileSaved landing frames
  // all swap in fresh references; the optimistic write in onToggle also goes through the
  // setState reference-swap chain (see onToggle), so field subscriptions notice it
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hostSettings = useAppStore((s) => s.hostSettings);
  // Skills master switch (base skills.enabled, defaults to on); when off the rest of the page's controls are dimmed and disabled
  const skillsEnabled = hostSettings?.skillsEnabled !== false;
  const [scope, setScope] = useState("profile"); // "profile" / "project:<cwd>"
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false); // more menu
  const [spin, setSpin] = useState(false); // refresh button spin
  const [openPath, setOpenPath] = useState<string | null>(null); // path of the skill being edited expand-down (null = collapsed)
  const [editText, setEditText] = useState(""); // editor content (locally controlled)
  const [editLoading, setEditLoading] = useState(false); // waiting for the asset_file reply to fill content
  const [editStatus, setEditStatus] = useState(""); // saving… / saved
  const seenStamp = useRef<unknown>(null); // already-consumed asset_file_saved reply (dedup by reference)
  const statusTimer = useRef<TimerHandle | undefined>(undefined);
  useExtSources(); // extension-center data for all scopes (for matching inline source badges)

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(
    allProjects.filter((c) => !removedProjects.includes(c))
  );

  // ---------- Data derivation (same as old currentSkillSections/getActiveSkillSection) ----------
  const data: SkillsData | undefined = agentAssets?.skills as SkillsData | undefined; // skills is temporarily unknown on the frames side (decided by the internal scan in host/assets.ts); this page narrows by actual reads
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

  // Fall back to the profile level when the current scope is stale
  const curSec: SkillSection =
    sections.find((s) => s.scope === scope) || profileSec;

  const installedCount = curSec.items.filter((item) => item.enabled).length;
  const q = query.trim().toLowerCase();
  const filtered = curSec.items.filter((item) => !q || item.name.toLowerCase().includes(q) || (item.description && item.description.toLowerCase().includes(q)));

  // ---------- Global click closes the more menu (the scope dropdown self-manages; equivalent of the old closeAllMenus) ----------
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [moreOpen]);

  // asset_file reply: fill the editor if it matches the current expanded row
  const assetFile = useAppStore((s) => s.assetFile);
  useEffect(() => {
    if (openPath && editLoading && assetFile && assetFile.kind === "skill" && assetFile.path === openPath) {
      setEditText(assetFile.content ?? "");
      setEditLoading(false);
    }
  });

  // asset_file_saved reply: expanded area status line shows "saved", cleared after 2s
  const assetFileSaved = useAppStore((s) => s.assetFileSaved);
  useEffect(() => {
    const st = assetFileSaved;
    if (!st || st.kind !== "skill" || seenStamp.current === st) return;
    seenStamp.current = st; // mark consumed regardless of whether the expanded area is still open, to prevent replays
    if (!openPath) return;
    setEditStatus(t("settingsPage.shared.saved"));
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setEditStatus(""), 2000);
  }, [assetFileSaved, openPath]);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  // ---------- Interaction (1:1 port of the old event bindings) ----------
  function toggleSkills() {
    const next = !skillsEnabled;
    send({ type: "set_skills_enabled", enabled: next });
    toast(next ? t("settingsPage.skills.onToast") : t("settingsPage.skills.offToast"));
  }

  function toggleEditor(s: SkillItem) {
    if (openPath === s.path) { setOpenPath(null); return; } // clicking again collapses
    setOpenPath(s.path);
    setEditText(t("settingsPage.shared.reading"));
    setEditLoading(true);
    setEditStatus("");
    send({ type: "asset_file_read", kind: "skill", path: s.path });
  }

  function onToggle(item: SkillItem) {
    const next = !item.enabled;
    // Optimistic reference swap: copy agentAssets → skills → the section array containing the
    // item and replace that item (field write notifies immediately; counts/toggles refresh on re-render)
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
    refreshExtSources(); // the ext-center tag beside the switch reads per-scope snapshots; refetch so the "disabled" tag follows the toggle
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
      refreshExtSources();
    } else if (id === "disableAll") {
      for (const s of curSec.items) if (s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: false });
      refreshExtSources();
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
      setOpenPath(null); // same as old version: collapse the expanded area right after confirming
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
      <div className="skills-bar-primary">
        <div className="skills-scope-wrap">
          <ScopeSel
            value={scope}
            onChange={(id) => { setScope(id); setOpenPath(null); }}
            profile={{ id: profileSec.scope, label: profileSec.label }}
            projects={projectSecs.map((s) => ({ id: s.scope, label: s.label }))}
          />
        </div>
        <div className="skills-search-wrap">
          <span className="skills-search-icon"><Icon name="search" size={14} /></span>
          <input type="text" className="skills-search-input" id="skillsSearchInput" placeholder={t("settingsPage.skills.searchPlaceholder")} spellCheck={false} autoComplete="off"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpenPath(null); }} />
        </div>
      </div>

      <div className="skills-bar-secondary">
        <div className="text-ui-sm font-medium text-dim">{t("settingsPage.skills.installedCount", { count: installedCount })}</div>
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
      {/* Skill editing: click a row to expand the editor downward (see mem-expand above) */}
      <SchemaRows sections={PAGE_PLACEMENT["pg-skills"]} />
      </div>
    </div>
  );
}
