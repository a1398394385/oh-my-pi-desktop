// Settings · subagent assets page (ported from ui/settings/agents.js + index.html #pg-agents):
// scope capsule (global / Profile / project, three levels) + left asset list + right inline editor.
// Clicking a list row reads that level's agent definition (Markdown + YAML frontmatter) into the
// editor; after saving, newly derived subagents take effect immediately.
// Creation opens the page-level form window (AgentCreateWindow, same chrome as the skills
// editor): the form composes the frontmatter and the create reply triggers the content write.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, pathBase } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow, EditWindowHead, FormRow } from "../common";
import ScopeSel from "../ScopeSel";
import { EnabledModelPicker } from "../../ModelPicker";
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

// Built-in tool names offered by the creation form; mirrors the base registry
// (pi-coding-agent tools/builtin-names.ts BUILTIN_TOOL_NAMES) as a literal because the SDK
// module pulls the whole tool runtime, unfit for the browser bundle.
const AGENT_TOOL_NAMES = [
  "read", "bash", "edit", "ast_grep", "ast_edit", "ask", "debug", "ida", "eval", "github",
  "glob", "grep", "find", "lsp", "checkpoint", "rewind", "context_notes", "new_context",
  "security_scan", "task", "wait", "todo", "web_search", "write", "memory_edit", "retain",
  "recall", "reflect", "learn", "manage_skill",
];

// Subset shown before the "show all" expand: the everyday file/shell/search/task tools a
// subagent typically needs; the rest (debuggers, github, memory bank, lifecycle) hide behind it.
const COMMON_AGENT_TOOL_NAMES = ["read", "bash", "edit", "write", "glob", "grep", "find", "task", "todo", "web_search"];

// Resolve a scope key ("profile" | "project:<cwd>") into the asset RPC payload shape
function scopeParts(scope: string): { scope: string; cwd?: string } {
  const ci = scope.indexOf(":");
  return ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
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

// Page-level creation window: composes the agent definition (YAML frontmatter + system prompt
// body) and persists it through the plain asset RPCs — asset_file_create places agents/<name>.md
// with a template, the asset_file reply then triggers asset_file_write with the composed
// content, and asset_file_saved (which also re-lists the assets) closes the window.
function AgentCreateWindow({ scope, onScopeChange, profile, projects, onClose }: {
  scope: string; // scope key ("profile" | "project:<cwd>"), mirrored from the page bar and switchable here
  onScopeChange: (id: string) => void;
  profile: { id: string; label: string };
  projects: { id: string; label: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const modelNames = useAppStore((s) => s.modelNames);
  const file = useAppStore((s) => s.assetFile);
  const saved = useAppStore((s) => s.assetSaved);
  const err = useAppStore((s) => s.assetErr);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [model, setModel] = useState(""); // "" = inherit the default task model (no frontmatter line)
  const [tools, setTools] = useState<Set<string>>(() => new Set(AGENT_TOOL_NAMES)); // all = unrestricted
  const [showAllTools, setShowAllTools] = useState(false); // expand the grid past the common subset
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState(""); // status / validation line under the form
  const lastSaved = useRef(useAppStore.getState().assetSaved?.at ?? 0); // replies that landed before mount must not fire
  const lastErr = useRef(useAppStore.getState().assetErr?.at ?? 0);
  const seenFile = useRef<unknown>(null);
  const creating = useRef(false); // a create request is in flight
  const pendingContent = useRef<string | null>(null); // composed definition awaiting the create reply

  // asset_file reply: when it answers our create, overwrite the template with the composed definition
  useEffect(() => {
    if (!file || file.kind !== "agent" || !file.path || seenFile.current === file) return;
    seenFile.current = file;
    const content = pendingContent.current;
    if (content === null) return;
    pendingContent.current = null;
    send({ type: "asset_file_write", kind: "agent", path: file.path, content });
  }, [file]);

  // asset_file_saved reply: toast then close (the handler already re-listed the assets)
  useEffect(() => {
    if (!saved || saved.kind !== "agent" || saved.at === lastSaved.current) return;
    lastSaved.current = saved.at;
    if (!creating.current) return;
    creating.current = false;
    toast(t("settingsPage.agents.form.createdToast", { name: name.trim().toLowerCase() }));
    onClose();
  }, [saved, name, onClose, t]);

  // Error landing (invalid name / already exists) stays in the window
  useEffect(() => {
    if (!err || err.kind !== "agent" || err.at === lastErr.current) return;
    lastErr.current = err.at;
    creating.current = false;
    setStatus(err.message);
  }, [err]);

  const inheritLabel = t("settingsPage.agents.form.inheritModel");
  const modelLabel = model ? (modelNames.get(model) ?? model) : inheritLabel;
  // Same picker family as the composer model menu (host-enabled chat models); the pinned
  // first-level row restores "inherit default" (model = "" omits the frontmatter line).
  const modelPicker = (
    <EnabledModelPicker
      label={modelLabel}
      selectedId={model || undefined}
      pinnedRows={[{ key: "__default", label: inheritLabel, onPick: () => setModel("") }]}
      onPick={setModel}
    />
  );

  const toggleTool = (tool: string) => {
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  };

  // YAML frontmatter + body; description is JSON-quoted (a valid YAML double-quoted scalar)
  const compose = (clean: string): string => {
    const lines = ["---", `name: ${clean}`, `description: ${JSON.stringify(desc.trim())}`];
    if (model) lines.push(`model: ${model}`);
    if (tools.size < AGENT_TOOL_NAMES.length) lines.push(`tools: ${AGENT_TOOL_NAMES.filter((x) => tools.has(x)).join(", ")}`);
    lines.push("---", "");
    const body = prompt.trim();
    return lines.join("\n") + "\n" + (body ? body + "\n" : "");
  };

  const submit = () => {
    const clean = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) {
      setStatus(t("settingsPage.agents.form.nameInvalid"));
      return;
    }
    if (!desc.trim()) {
      setStatus(t("settingsPage.agents.form.descRequired"));
      return;
    }
    setStatus(t("settingsPage.shared.saving"));
    creating.current = true;
    pendingContent.current = compose(clean);
    send({ type: "asset_file_create", kind: "agent", name: clean, ...scopeParts(scope) });
  };

  return (
    <>
      <EditWindowHead
        title={t("settingsPage.agents.form.newTitle")}
        sub={t("settingsPage.agents.form.newSub")}
        onBack={onClose}
      >
        <button type="button" className="frm-primary" onClick={submit}>
          {t("common.save")}
        </button>
      </EditWindowHead>

      <div className="set-card set-edit-card">
        <div className="frm-rows">
          <FormRow label={t("settingsPage.agents.form.scopeLabel")}>
            <div className="agent-form-scope frm-compact">
              <ScopeSel value={scope} onChange={onScopeChange} profile={profile} projects={projects} />
            </div>
          </FormRow>
          <div className="frm-pair">
            <FormRow label={t("settingsPage.agents.form.nameLabel")}>
              <input
                type="text"
                className="mcp-form-input mcp-form-code mcp-inp-name"
                placeholder={t("settingsPage.agents.form.namePlaceholder")}
                spellCheck={false}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormRow>
            <FormRow label={t("settingsPage.agents.form.modelLabel")}>
              <div className="agent-form-model">{modelPicker}</div>
            </FormRow>
          </div>
          <FormRow label={t("settingsPage.agents.form.descLabel")}>
            <input
              type="text"
              className="mcp-form-input"
              placeholder={t("settingsPage.agents.form.descPlaceholder")}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </FormRow>
          <FormRow label={t("settingsPage.agents.form.toolsLabel")}>
            <div className="agent-form-tools">
              {(showAllTools ? AGENT_TOOL_NAMES : AGENT_TOOL_NAMES.filter((x) => COMMON_AGENT_TOOL_NAMES.includes(x))).map((tool) => (
                <label className="agent-form-tool" key={tool}>
                  <input type="checkbox" checked={tools.has(tool)} onChange={() => toggleTool(tool)} />
                  <span className="agent-form-tool-name">{tool}</span>
                </label>
              ))}
            </div>
            <button type="button" className="mcp-env-toggle" onClick={() => setShowAllTools((v) => !v)}>
              <span className="caret-svg"><Icon name={showAllTools ? "chevronUp" : "chevronDown"} size={12} /></span>
              {showAllTools
                ? t("settingsPage.agents.form.toolsShowLess")
                : t("settingsPage.agents.form.toolsShowMore", { count: AGENT_TOOL_NAMES.length - COMMON_AGENT_TOOL_NAMES.length })}
            </button>
            <div className="frm-hint">{t("settingsPage.agents.form.toolsHint")}</div>
          </FormRow>
          <FormRow label={t("settingsPage.agents.form.promptLabel")}>
            <textarea
              className="mcp-form-textarea"
              rows={8}
              spellCheck={false}
              placeholder={t("settingsPage.agents.form.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </FormRow>
        </div>
        {status ? <div className="frm-hint agent-form-status">{status}</div> : null}
      </div>
    </>
  );
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
  const [creating, setCreating] = useState(false); // creation window open (replaces the page body)

  const data = agentAssets?.agents;
  const sections = assetSections(data, validProjectCwds);
  // Fall back to profile when the current scope is stale (e.g. the Profile got removed)
  if (sections && !sections.all.some((s) => s.scope === scope)) setScope("profile");
  const cur = sections?.all.find((s) => s.scope === scope) ?? sections?.profileSec;

  // asset_file reply (read/create succeeded): load into the editor (formerly openAssetEditor).
  // Skipped while the creation window is open — its own effect consumes the create reply.
  const file = useAppStore((s) => s.assetFile);
  useEffect(() => {
    if (creating) return;
    if (!file || file.kind !== "agent" || !file.path) return;
    setSelPath(file.path);
    setText(file.content);
    setStatus("");
    setEditorOpen(true);
  }, [file, creating]);

  // asset_file_saved reply: status line shows "saved" (formerly core.js assetStatus(kind, "saved"))
  const saved = useAppStore((s) => s.assetSaved);
  useEffect(() => {
    if (!saved || saved.kind !== "agent") return;
    setStatus(t("settingsPage.shared.saved"));
  }, [saved, t]);

  // Asset operation failure (read/save/create threw): host replies with an error frame; when
  // the store lands assetErr, clear in-progress state
  const err = useAppStore((s) => s.assetErr);
  useEffect(() => {
    if (!err || err.kind !== "agent") return;
    setStatus(err.message);
  }, [err]);

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

  // Creation window replaces the whole page body (same chrome as the skills editor window);
  // the scope selector is mirrored inside the window, sharing this state (ZCode form parity)
  if (creating) {
    return (
      <div className="set-page" id="pg-agents">
        <AgentCreateWindow
          scope={scope}
          onScopeChange={pickScope}
          profile={{ id: "profile", label: sections?.profileSec.label ?? `Profile · ${data?.profileName ?? "default"}` }}
          projects={(sections?.projectSecs ?? []).map((s) => ({ id: s.scope, label: s.label }))}
          onClose={() => setCreating(false)}
        />
      </div>
    );
  }

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
        <button type="button" className="skills-btn-new" id="agentsNewBtn" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          <span>{t("settingsPage.shared.newBtn")}</span>
        </button>
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
            <button type="button" className="save-btn" id="aeSave" onClick={save}>{t("common.save")}</button>
          </div>
          <textarea id="aeText" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="ae-status" id="aeStatus">{status}</div>
        </div>
      </div>
    </div>
  );
}
