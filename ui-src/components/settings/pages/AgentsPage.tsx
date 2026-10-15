// Settings · subagent assets page (ported from ui/settings/agents.js + index.html #pg-agents):
// scope capsule (global / Profile / project, three levels) + left asset list + right inline editor.
// Clicking a list row reads that level's agent definition (Markdown + YAML frontmatter) into the
// editor; after saving, newly derived subagents take effect immediately.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, pathBase } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import ScopeSel from "../ScopeSel";
import type { AgentAssetsPayload } from "../../../types/frames";

// Asset entry: agent payload fields of the host list_agent_assets reply (boundary defined by the host reply)
interface AssetItem {
  name: string;
  path: string;
  description?: string;
  command?: string;
}

// Asset group: level-one scope (global / profile / project:<cwd>) + display metadata
interface AssetSection {
  scope: string;
  label: string;
  dir: string;
  items: AssetItem[];
}

// Normalize the host's two-level payload into {profileSec, projectSecs}
function assetSections(data: AgentAssetsPayload["agents"] | null | undefined, validProjectCwds?: Set<string>): { profileSec: AssetSection; projectSecs: AssetSection[]; all: AssetSection[] } | null {
  if (!data) return null;
  const sec = (scope: string, items: AssetItem[], dir: string, label: string): AssetSection => ({ scope, label, dir, items });
  const profileSec = sec("profile", data.profile ?? [], data.profileDir, `Profile · ${data.profileName ?? "default"}`);
  const projectSecs = (data.projects ?? [])
    .filter((p) => Boolean(validProjectCwds && validProjectCwds.has(p.cwd)))
    .map((p) => sec(`project:${p.cwd}`, p.agents ?? [], p.dir, p.name));
  return {
    profileSec,
    projectSecs,
    all: [profileSec, ...projectSecs],
  };
}

export default function AgentsPage() {
  const { t } = useTranslation();
  // Render data via field selectors: ws-side landing frames swap all references fresh (including assetErr), so field subscriptions notice
  const agentAssets = useAppStore((s) => s.agentAssets);
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(
    allProjects.filter((c) => !removedProjects.includes(c))
  );

  const [scope, setScope] = useState("profile"); // current scope key (formerly assetScope.agent)
  const [spin, setSpin] = useState(false); // refresh button spin
  const [selPath, setSelPath] = useState<string | null>(null); // editor's current file path (formerly assetSelPath.agent)
  const [text, setText] = useState(""); // editor content (controlled textarea)
  const [editorOpen, setEditorOpen] = useState(false); // editor visibility (formerly #agentEditor.hidden)
  const [status, setStatus] = useState(""); // aeStatus line
  const [newName, setNewName] = useState(""); // create-new name input

  const data = agentAssets?.agents;
  const sections = assetSections(data, validProjectCwds);
  // Fall back to profile when the current scope is stale (e.g. the Profile got removed)
  if (sections && !sections.all.some((s) => s.scope === scope)) setScope("profile");
  const cur = sections?.all.find((s) => s.scope === scope) ?? sections?.profileSec;

  // asset_file reply (read/create succeeded): load into the editor (formerly openAssetEditor)
  const file = useAppStore((s) => s.assetFile);
  useEffect(() => {
    if (!file || file.kind !== "agent" || !file.path) return;
    setSelPath(file.path);
    setText(file.content);
    setStatus("");
    setEditorOpen(true);
  }, [file]);

  // asset_file_saved reply: status line shows "saved" (formerly core.js assetStatus(kind, "saved"))
  const saved = useAppStore((s) => s.assetSaved);
  useEffect(() => {
    if (!saved || saved.kind !== "agent") return;
    setStatus(t("settingsPage.shared.saved"));
  }, [saved]);

  // Asset operation failure (read/save/create threw): host replies with an error frame; when
  // the store lands assetErr, clear in-progress state
  const err = useAppStore((s) => s.assetErr);
  useEffect(() => {
    if (!err || err.kind !== "agent") return;
    setStatus(err.message);
  }, [err]);

  // Resolve the current scope into {scope, cwd?} (formerly assetScopeParts)
  const scopeParts = (): { scope: string; cwd?: string } => {
    const ci = scope.indexOf(":");
    return ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
  };

  const pickScope = (id: string) => {
    setScope(id);
    setSelPath(null);
    setEditorOpen(false);
  };

  const refresh = () => {
    send({ type: "list_agent_assets" });
    setSpin(true);
    setTimeout(() => setSpin(false), 500);
  };

  const readItem = (m: AssetItem) => {
    setSelPath(m.path);
    setStatus(t("settingsPage.shared.reading"));
    send({ type: "asset_file_read", kind: "agent", path: m.path });
  };

  const save = () => {
    if (!selPath) return;
    setStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_write", kind: "agent", path: selPath, content: text });
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return setStatus(t("settingsPage.shared.nameFirst"));
    send({ type: "asset_file_create", kind: "agent", name, ...scopeParts() });
  };

  return (
    <div className="set-page" id="pg-agents">
      <div className="set-tt">
        {t("settingsPage.nav.subagents")}
        <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} onClick={refresh} title={t("settingsPage.model.refresh")}>
          <Icon name="refresh" size={17} />
        </button>
      </div>
      <div className="set-note">
        <b>{t("settingsPage.agents.noteTitle")}</b>
        <span>
          {t("settingsPage.agents.noteBodyA")}<code>~/.omp/profiles/&lt;profile&gt;/agent/agents</code>{t("settingsPage.agents.noteBodyB")}<code>&lt;project&gt;/.omp/agents</code>{t("settingsPage.agents.noteBodyC")}
        </span>
      </div>
      <div className="agents-bar">
        <ScopeSel
          value={scope}
          onChange={pickScope}
          profile={{ id: "profile", label: sections?.profileSec.label ?? `Profile · ${data?.profileName ?? "default"}` }}
          projects={(sections?.projectSecs ?? []).map((s) => ({ id: s.scope, label: s.label }))}
        />
        <span className="truncate text-ui-sm text-faint" id="agentsScopePath">{cur?.dir ?? ""}</span>
      </div>
      <div className="agents-wrap">
        <div className="set-card" id="agentsList">
          {!cur ? (
            emptyRow(t("common.loading"))
          ) : cur.items.length === 0 ? (
            emptyRow(t("settingsPage.shared.emptyNone"))
          ) : (
            cur.items.map((m) => (
              <div className="srow" key={m.path} style={{ cursor: "pointer" }} onClick={() => readItem(m)}>
                <div className="srow-tx">
                  <b>{m.name}</b>
                  {(m.description || m.command || m.path) && <span>{m.description || m.command || m.path}</span>}
                </div>
                <span className="ext-badges">
                  <span className="tag">{cur.scope.startsWith("project:") ? t("settingsPage.agents.projectLevel") : t("settingsPage.agents.userLevel")}</span>
                </span>
              </div>
            ))
          )}
        </div>
        <div className={"set-card agent-editor" + (editorOpen ? "" : " hidden")} id="agentEditor">
          <div className="ae-head">
            <b id="aeName">{selPath ? pathBase(selPath) : "—"}</b>
            <span id="aePath">{selPath ?? ""}</span>
            <span className="sp" />
            <input
              className="inp"
              id="aeNewName"
              placeholder={t("settingsPage.agents.newPlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button type="button" className="add-btn" id="aeNew" onClick={create}>{t("settingsPage.shared.newBtn")}</button>
            <button type="button" className="save-btn" id="aeSave" onClick={save}>{t("common.save")}</button>
          </div>
          <textarea id="aeText" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="ae-status" id="aeStatus">{status}</div>
        </div>
      </div>
    </div>
  );
}
