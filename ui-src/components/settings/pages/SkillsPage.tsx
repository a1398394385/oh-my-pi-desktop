// Settings · Skills page (React version): multi-directory discovery, enable toggles, search.
// Create and edit open the page-level editor window (.set-edit-*), which replaces the whole
// page body: create asks for the file name and the host writes skills/<name>/SKILL.md; edit
// reads the file on mount and writes it back on save.
// Logic ported 1:1 from ui/settings/skills.js; DOM cross-check git 464131d ui/index.html #pg-skills.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow, EditWindowHead } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { ExtSourceTag, useExtSources, refreshExtSources } from "../ExtSourceTag";
import ScopeSel from "../ScopeSel";
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";

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

// Page-level skill editor window: replaces the whole page body for both flows.
// Create: the name field goes out as asset_file_create; the host writes the template file and
// replies with asset_file + agent_assets (list refresh), which closes the window.
// Edit: mount reads the file (asset_file_read), save writes it back (asset_file_write), and the
// asset_file_saved reply (which also re-lists the assets) closes the window with a toast.
function SkillEditWindow({ skill, scope, onClose }: {
  skill: SkillItem | null; // null = create
  scope: { scope: string; cwd?: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isNew = !skill;
  const assetFile = useAppStore((s) => s.assetFile);
  const saved = useAppStore((s) => s.assetFileSaved);
  const err = useAppStore((s) => s.assetErr);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  // Replies that landed before this window mounted must not fire (both frames carry `at`)
  const lastSaved = useRef(useAppStore.getState().assetFileSaved?.at ?? 0);
  const lastErr = useRef(useAppStore.getState().assetErr?.at ?? 0);
  const seenFile = useRef<unknown>(null);
  const creating = useRef(false); // a create request is in flight

  // Mount (edit) = read this skill's file
  useEffect(() => {
    if (skill) send({ type: "asset_file_read", kind: "skill", path: skill.path });
  }, [skill]);

  // asset_file reply: fills the editor (edit) or closes the window (create finished)
  useEffect(() => {
    if (!assetFile || assetFile.kind !== "skill" || seenFile.current === assetFile) return;
    seenFile.current = assetFile;
    if (isNew) {
      if (!creating.current) return;
      creating.current = false;
      toast(t("settingsPage.skills.createdToast", { name }));
      onClose();
      return;
    }
    if (assetFile.path === skill!.path) {
      setText(assetFile.content ?? "");
      setStatus("");
    }
  }, [assetFile, isNew, skill, name, onClose, t]);

  // asset_file_saved reply: toast then close (the host re-lists the assets on this frame)
  useEffect(() => {
    if (!saved || saved.kind !== "skill" || saved.at === lastSaved.current) return;
    lastSaved.current = saved.at;
    toast(t("settingsPage.skills.savedToast", { name: skill?.name ?? name }));
    onClose();
  }, [saved, onClose, skill, name, t]);

  // Error landing (invalid name / already exists / read failure) stays in the window
  useEffect(() => {
    if (!err || err.kind !== "skill" || err.at === lastErr.current) return;
    lastErr.current = err.at;
    creating.current = false;
    setStatus(err.message);
  }, [err]);

  const create = () => {
    const clean = name.trim().toLowerCase();
    if (!clean) {
      toast(t("settingsPage.shared.nameFirst"));
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) {
      toast(t("settingsPage.skills.nameInvalid"));
      return;
    }
    setStatus(t("settingsPage.shared.saving"));
    creating.current = true;
    send({ type: "asset_file_create", kind: "skill", name: clean, ...scope });
  };

  const save = () => {
    if (!skill) return;
    setStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_write", kind: "skill", path: skill.path, content: text });
  };

  const onDelete = async () => {
    if (!skill) return;
    if (await confirmDialog({ title: t("settingsPage.skills.deleteTitle"), message: t("settingsPage.skills.deleteMsgUndo", { name: skill.name }), confirmText: t("common.delete"), danger: true })) {
      send({ type: "asset_skill_delete", path: skill.path });
      onClose();
    }
  };

  return (
    <>
      <EditWindowHead
        title={isNew ? t("settingsPage.skills.newTitle") : t("settingsPage.skills.editTitle")}
        sub={isNew ? t("settingsPage.skills.nameHint") : skill!.path}
        onBack={onClose}
      >
        {!isNew && (
          <button type="button" className="save-btn danger" onClick={onDelete}>
            {t("common.delete")}
          </button>
        )}
        {isNew ? (
          <button type="button" className="save-btn" onClick={create}>
            {t("settingsPage.shared.create")}
          </button>
        ) : (
          <button type="button" className="save-btn" onClick={save}>
            {t("common.save")}
          </button>
        )}
      </EditWindowHead>

      <div className="set-card set-edit-card">
        {isNew ? (
          <div className="mcp-form-group">
            <label className="mcp-form-label">{t("settingsPage.skills.nameLabel")}</label>
            <input
              type="text"
              className="mcp-form-input mcp-form-code"
              placeholder={t("settingsPage.skills.namePlaceholder")}
              spellCheck={false}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </div>
        ) : (
          <div className="mcp-form-group">
            <label className="mcp-form-label">{t("settingsPage.skills.editTitle")}</label>
            <textarea
              className="mcp-form-textarea mcp-form-code"
              rows={24}
              spellCheck={false}
              placeholder={t("settingsPage.skills.editPlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}
        {status ? <div className="mcp-form-hint">{status}</div> : null}
      </div>
    </>
  );
}

export default function SkillsPage() {
  const { t } = useTranslation();
  // Render data via field selectors: the agentAssets landing frame swaps in a fresh reference;
  // the optimistic write in onToggle also goes through the setState reference-swap chain
  // (see onToggle), so field subscriptions notice it
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hostSettings = useAppStore((s) => s.hostSettings);
  // Skills master switch (base skills.enabled, defaults to on); when off the rest of the page's controls are dimmed and disabled
  const skillsEnabled = hostSettings?.skillsEnabled !== false;
  const [scope, setScope] = useState("profile"); // "profile" / "project:<cwd>"
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false); // more menu
  const [spin, setSpin] = useState(false); // refresh button spin
  // Open editor window (replaces the page body): "new" or the skill being edited; null = list
  const [edit, setEdit] = useState<{ mode: "new" } | { mode: "edit"; skill: SkillItem } | null>(null);
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
    claimDropdown(close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      releaseDropdown(close);
    };
  }, [moreOpen]);

  // ---------- Interaction (1:1 port of the old event bindings) ----------
  function toggleSkills() {
    const next = !skillsEnabled;
    send({ type: "set_skills_enabled", enabled: next });
    toast(next ? t("settingsPage.skills.onToast") : t("settingsPage.skills.offToast"));
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

  // Scope of the current section as { scope, cwd? } for the editor window's create request
  const scopeParts = (): { scope: string; cwd?: string } => {
    const ci = curSec.scope.indexOf(":");
    return ci < 0 ? { scope: curSec.scope } : { scope: curSec.scope.slice(0, ci), cwd: curSec.scope.slice(ci + 1) };
  };

  // Rows lead into the page-level editor window (creation asks for the name there instead)
  if (edit) {
    return (
      <div className="set-page" id="pg-skills">
        <SkillEditWindow
          skill={edit.mode === "edit" ? edit.skill : null}
          scope={scopeParts()}
          onClose={() => setEdit(null)}
        />
      </div>
    );
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
            onChange={(id) => setScope(id)}
            profile={{ id: profileSec.scope, label: profileSec.label }}
            projects={projectSecs.map((s) => ({ id: s.scope, label: s.label }))}
          />
        </div>
        <div className="skills-search-wrap">
          <span className="skills-search-icon"><Icon name="search" size={14} /></span>
          <input type="text" className="skills-search-input" id="skillsSearchInput" placeholder={t("settingsPage.skills.searchPlaceholder")} spellCheck={false} autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)} />
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
          <button type="button" className="skills-btn-new" id="skillsNewBtn" onClick={() => setEdit({ mode: "new" })}>
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
                <div className="skill-item-row" key={s.path} data-path={s.path} data-name={s.name}
                  onClick={() => setEdit({ mode: "edit", skill: s })}>
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
              ))}
        </div>
      </div>
      {/* Skill editing: a row click opens the page-level editor window (see SkillEditWindow) */}
      <SchemaRows sections={PAGE_PLACEMENT["pg-skills"]} />
      </div>
    </div>
  );
}
