// 设置·子智能体资产页（agent 定义）：作用域胶囊 + 三级列表 + 行内编辑器。
// 每项 id 对应 index.html 中各页元素；rowsClickable=true 时列表行可点击读取进右侧编辑器。
import { $, S, send } from "../core.js";
import { emptyRow, wireSel } from "./index.js";

export function fillAssetList(id, items, write) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren();
  if (!items.length) {
    el.appendChild(emptyRow("暂无"));
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "srow";
    const tx = document.createElement("div");
    tx.className = "srow-tx";
    write(tx, item);
    row.appendChild(tx);
    el.appendChild(row);
  }
}
export function assetTitle(parent, title, sub) {
  const b = document.createElement("b");
  b.textContent = title;
  parent.appendChild(b);
  if (sub) {
    const span = document.createElement("span");
    span.textContent = sub;
    parent.appendChild(span);
  }
}

export const ASSET_PAGES = {
  agent: {
    sel: "agentScopeSel", menu: "agentScopeMenu", label: "agentScopeLabel", hint: "agentsScopePath", list: "agentsList",
    editor: "agentEditor", name: "aeName", path: "aePath", newName: "aeNewName", create: "aeNew", save: "aeSave", text: "aeText", status: "aeStatus",
    rowsClickable: true,
  },
};
const assetScope = { agent: "profile" };
export const assetSelPath = { agent: null };
// 把宿主三级负载归一化成 [{scope, label, dir, items}]
function assetSections(kind, data) {
  if (!data) return null;
  const sec = (scope, items, dir, label) => ({ scope, label, dir, items });
  return [
    sec("global", data.global, data.globalDir, "全局"),
    sec("profile", data.profile, data.profileDir, `Profile · ${data.profileName ?? "default"}`),
    ...data.projects.map((p) => sec(`project:${p.cwd}`, p.agents ?? [], p.dir, p.name)),
  ];
}
function assetData(kind) {
  if (!S.agentAssets) return null;
  return S.agentAssets.agents;
}
export function renderAssetPage(kind) {
  const ids = ASSET_PAGES[kind];
  if (!ids) return;
  const sections = assetSections(kind, assetData(kind));
  if (!sections) return;
  if (!sections.some((s) => s.scope === assetScope[kind])) assetScope[kind] = "profile";
  const scope = assetScope[kind];
  // 胶囊菜单：全局 → Profile → 项目，组间分隔线，选中项打勾，超长项目名省略
  const menu = $(ids.menu);
  menu.replaceChildren();
  sections.forEach((s, i) => {
    if (i > 0) menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.dataset.scope = s.scope;
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = "✓";
    ck.style.visibility = s.scope === scope ? "visible" : "hidden";
    const lb = document.createElement("span");
    lb.className = "mi-label";
    lb.textContent = s.label;
    lb.title = s.label;
    mi.appendChild(ck);
    const scopeIcon = s.scope === "global" ? icon("scopeGlobal") : s.scope === "profile" ? icon("scopeProfile") : icon("folder");
    if (scopeIcon) mi.insertAdjacentHTML("beforeend", scopeIcon);
    mi.appendChild(lb);
    menu.appendChild(mi);
  });
  // 触发器标签与当前级目录/文件提示
  const cur = sections.find((s) => s.scope === scope);
  $(ids.label).textContent = cur.label;
  $(ids.hint).textContent = cur.dir ?? "";
  fillAssetList(ids.list, cur.items, (tx, m) => assetTitle(tx, m.name, m.description || m.command || m.path));
  // 点击行读取定义进右侧编辑器（MCP 列表行是服务器条目，不可点）
  if (ids.rowsClickable) {
    const rows = $(ids.list).querySelectorAll(".srow");
    cur.items.forEach((m, i) => {
      const row = rows[i];
      if (!row) return;
      row.style.cursor = "pointer";
      row.onclick = () => {
        assetSelPath[kind] = m.path;
        assetStatus(kind, "读取中…");
        send({ type: "asset_file_read", kind, path: m.path });
      };
    });
  }
}
export function assetStatus(kind, t) {
  const el = ASSET_PAGES[kind] ? $(ASSET_PAGES[kind].status) : null;
  if (el) el.textContent = t;
}
export function openAssetEditor(kind, file, content) {
  const ids = ASSET_PAGES[kind];
  if (!ids) return;
  assetSelPath[kind] = file;
  $(ids.editor).classList.remove("hidden");
  $(ids.name).textContent = file.split("/").pop();
  $(ids.path).textContent = file;
  $(ids.text).value = content;
  assetStatus(kind, "");
}
// 当前作用域解析成 {scope, cwd?}
function assetScopeParts(kind) {
  const s = assetScope[kind];
  const ci = s.indexOf(":");
  return ci < 0 ? { scope: s } : { scope: s.slice(0, ci), cwd: s.slice(ci + 1) };
}

export function initAgents() {
  for (const [kind, ids] of Object.entries(ASSET_PAGES)) {
    wireSel(ids.sel, (mi) => {
      assetScope[kind] = mi.dataset.scope;
      assetSelPath[kind] = null;
      $(ids.editor).classList.add("hidden");
      renderAssetPage(kind);
    });
    $(ids.save).addEventListener("click", () => {
      if (!assetSelPath[kind]) return;
      assetStatus(kind, "保存中…");
      send({ type: "asset_file_write", kind, path: assetSelPath[kind], content: $(ids.text).value });
    });
    $(ids.create).addEventListener("click", () => {
      const parts = assetScopeParts(kind);
      const name = $(ids.newName).value.trim();
      if (!name) return assetStatus(kind, "先输入名称");
      send({ type: "asset_file_create", kind, name, ...parts });
    });
    if (ids.newName) {
      $(ids.newName).addEventListener("keydown", (e) => {
        if (e.key === "Enter") $(ids.create).click();
      });
    }
  }
}
