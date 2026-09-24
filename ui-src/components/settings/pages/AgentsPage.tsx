// 设置·子智能体资产页（原 ui/settings/agents.js + index.html #pg-agents 平移）：
// 作用域胶囊（全局 / Profile / 项目三级）+ 左侧资产列表 + 右侧行内编辑器。
// 点击列表行读取该级 agent 定义（Markdown + YAML frontmatter）进编辑器，保存后新派生的子代理立即生效。
import { useEffect, useState } from "react";
import { S, useStore, send } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import type { AgentAssetsPayload } from "../../../types/frames";

// 资产条目：宿主 list_agent_assets 回包的 agent 负载字段（边界以宿主回包为准）
interface AssetItem {
  name: string;
  path: string;
  description?: string;
  command?: string;
}

// 资产分组：一级作用域（global / profile / project:<cwd>）+ 展示元信息
interface AssetSection {
  scope: string;
  label: string;
  dir: string;
  items: AssetItem[];
}

// 宿主三级负载归一化成 [{scope, label, dir, items}]（原 assetSections 平移）
function assetSections(data: AgentAssetsPayload["agents"] | null | undefined): AssetSection[] | null {
  if (!data) return null;
  const sec = (scope: string, items: AssetItem[], dir: string, label: string): AssetSection => ({ scope, label, dir, items });
  return [
    sec("global", data.global, data.globalDir, "全局"),
    sec("profile", data.profile, data.profileDir, `Profile · ${data.profileName ?? "default"}`),
    ...data.projects.map((p) => sec(`project:${p.cwd}`, p.agents ?? [], p.dir, p.name)),
  ];
}

export default function AgentsPage() {
  useStore(); // 订阅 S：agentAssets / assetFile / assetSaved 回包落地后重渲染
  const [scope, setScope] = useState("profile"); // 当前作用域键（原 assetScope.agent）
  const [menuOpen, setMenuOpen] = useState(false); // 作用域胶囊菜单（原 wireSel 的 .menu.open）
  const [spin, setSpin] = useState(false); // 刷新钮旋转
  const [selPath, setSelPath] = useState<string | null>(null); // 编辑器当前文件路径（原 assetSelPath.agent）
  const [text, setText] = useState(""); // 编辑器内容（受控 textarea）
  const [editorOpen, setEditorOpen] = useState(false); // 编辑器显隐（原 #agentEditor.hidden）
  const [status, setStatus] = useState(""); // aeStatus 行
  const [newName, setNewName] = useState(""); // 新建名称输入

  const data = S.agentAssets?.agents;
  const sections = assetSections(data);
  // 当前作用域失效（如 Profile 被移除）时回落 profile（原 renderAssetPage 同款守卫）
  if (sections && !sections.some((s) => s.scope === scope)) setScope("profile");
  const cur = sections?.find((s) => s.scope === scope) ?? sections?.find((s) => s.scope === "profile");

  // asset_file 回包（读取/新建成功）：载入编辑器（原 openAssetEditor）
  const file = S.assetFile;
  useEffect(() => {
    if (!file || file.kind !== "agent" || !file.path) return;
    setSelPath(file.path);
    setText(file.content);
    setStatus("");
    setEditorOpen(true);
  }, [file]);

  // asset_file_saved 回包：状态行显示「已保存」（原 core.js assetStatus(kind, "已保存")）
  const saved = S.assetSaved;
  useEffect(() => {
    if (!saved || saved.kind !== "agent") return;
    setStatus("已保存");
  }, [saved]);

  // 资产操作失败（读取/保存/新建抛错）：宿主回 error 帧，store 落 S.assetErr 时清掉进行中状态
  const err = S.assetErr;
  useEffect(() => {
    if (!err || err.kind !== "agent") return;
    setStatus(err.message);
  }, [err]);

  // 点击菜单外关闭（原 closeAllMenus 的文档级监听）
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  // 当前作用域解析成 {scope, cwd?}（原 assetScopeParts）
  const scopeParts = (): { scope: string; cwd?: string } => {
    const ci = scope.indexOf(":");
    return ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
  };

  const pickScope = (s: AssetSection) => {
    setScope(s.scope);
    setSelPath(null);
    setEditorOpen(false);
    setMenuOpen(false);
  };

  const refresh = () => {
    send({ type: "list_agent_assets" });
    setSpin(true);
    setTimeout(() => setSpin(false), 500);
  };

  const readItem = (m: AssetItem) => {
    setSelPath(m.path);
    setStatus("读取中…");
    send({ type: "asset_file_read", kind: "agent", path: m.path });
  };

  const save = () => {
    if (!selPath) return;
    setStatus("保存中…");
    send({ type: "asset_file_write", kind: "agent", path: selPath, content: text });
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return setStatus("先输入名称");
    send({ type: "asset_file_create", kind: "agent", name, ...scopeParts() });
  };

  return (
    <div className="set-page" id="pg-agents">
      <div className="set-tt">
        子智能体
        <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} onClick={refresh} title="刷新">
          <Icon name="refresh" size={17} />
        </button>
      </div>
      <div className="set-note">
        <b>编辑磁盘定义</b>
        <span>
          左上角切换作用域后，点击条目读取并编辑该级 agent 定义（Markdown + YAML frontmatter），保存后新派生的子代理立即生效。三级目录：全局 <code>~/.omp/agent/agents</code>、当前 Profile <code>~/.omp/profiles/&lt;profile&gt;/agent/agents</code>、项目 <code>&lt;项目&gt;/.omp/agents</code>。omp 加载优先级：项目 &gt; Profile &gt; 内置；内置 agent 打包在 omp 内，不在此列。
        </span>
      </div>
      <div className="agents-bar">
        <div
          className="sel"
          id="agentScopeSel"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <span id="agentScopeLabel">{cur?.label ?? "Profile"}</span> <Icon name="caret" size={14} className="caret-svg" />
          {menuOpen && cur && sections && (
            <div className="menu open" id="agentScopeMenu" onClick={(e) => e.stopPropagation()}>
              {sections.map((s, i) => (
                <span key={s.scope} style={{ display: "contents" }}>
                  {i > 0 && <div className="sep" />}
                  <div className="mi" data-scope={s.scope} onClick={() => pickScope(s)}>
                    <span className="ck" style={{ visibility: s.scope === scope ? "visible" : "hidden" }}>✓</span>
                    <Icon name={s.scope === "global" ? "scopeGlobal" : s.scope === "profile" ? "scopeProfile" : "folder"} size={14} />
                    <span className="mi-label" title={s.label}>{s.label}</span>
                  </div>
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="agents-bar-path" id="agentsScopePath">{cur?.dir ?? ""}</span>
      </div>
      <div className="agents-wrap">
        <div className="set-card" id="agentsList">
          {!cur ? (
            emptyRow("加载中…")
          ) : cur.items.length === 0 ? (
            emptyRow("暂无")
          ) : (
            cur.items.map((m) => (
              <div className="srow" key={m.path} style={{ cursor: "pointer" }} onClick={() => readItem(m)}>
                <div className="srow-tx">
                  <b>{m.name}</b>
                  {(m.description || m.command || m.path) && <span>{m.description || m.command || m.path}</span>}
                </div>
              </div>
            ))
          )}
        </div>
        <div className={"set-card agent-editor" + (editorOpen ? "" : " hidden")} id="agentEditor">
          <div className="ae-head">
            <b id="aeName">{selPath ? selPath.split("/").pop() : "—"}</b>
            <span id="aePath">{selPath ?? ""}</span>
            <span className="sp" />
            <input
              className="inp"
              id="aeNewName"
              placeholder="新 agent 名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button type="button" className="add-btn" id="aeNew" onClick={create}>新建</button>
            <button type="button" className="save-btn" id="aeSave" onClick={save}>保存</button>
          </div>
          <textarea id="aeText" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="ae-status" id="aeStatus">{status}</div>
        </div>
      </div>
    </div>
  );
}
