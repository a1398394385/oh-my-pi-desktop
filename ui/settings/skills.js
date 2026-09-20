// 设置·技能页：多目录发现、启用开关、搜索、行内延展编辑（仿最新设计图）。
import { $, S, send, toast } from "../core.js";
import { wireSel } from "./index.js";

let skillScope = "global"; // "global" (用户) / "profile" / "project:<cwd>"
let skillSearchQuery = "";
let skillEditingPath = null;
let skillsEventsWired = false;

function currentSkillSections() {
  const data = S.agentAssets?.skills;
  if (!data) return [];
  const sec = (scope, label, iconName, dir, items) => ({ scope, label, iconName, dir, items: items || [] });
  const list = [
    sec("global", "用户", "laptop", data.globalDir, data.global),
  ];
  if (data.profile && data.profile.length > 0) {
    list.push(sec("profile", `Profile · ${data.profileName ?? "default"}`, "scopeProfile", data.profileDir, data.profile));
  }
  for (const p of (data.projects || [])) {
    list.push(sec(`project:${p.cwd}`, p.name, "folder", p.dir, p.skills));
  }
  return list;
}

function getActiveSkillSection() {
  const sections = currentSkillSections();
  let found = sections.find((s) => s.scope === skillScope);
  if (!found) {
    skillScope = "global";
    found = sections[0] || { scope: "global", label: "用户", iconName: "laptop", dir: "", items: [] };
  }
  return found;
}

export function renderSkillsPage() {
  const curSec = getActiveSkillSection();
  const allSections = currentSkillSections();

  // 更新作用域按钮文字与图标
  const labelEl = $("skillScopeLabel");
  if (labelEl) labelEl.textContent = curSec.label;
  const iconSpan = $("skillScopeBtn")?.querySelector(".skills-scope-icon");
  if (iconSpan) iconSpan.innerHTML = icon(curSec.iconName || "laptop", 14);

  // 渲染作用域下拉菜单
  const menu = $("skillScopeMenu");
  if (menu) {
    menu.replaceChildren();
    allSections.forEach((s, i) => {
      if (i > 0) menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.scope = s.scope;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = "✓";
      ck.style.visibility = s.scope === curSec.scope ? "visible" : "hidden";
      const lb = document.createElement("span");
      lb.className = "mi-label";
      lb.textContent = s.label;
      lb.title = s.label;
      mi.appendChild(ck);
      const ic = icon(s.iconName || "folder", 13);
      if (ic) mi.insertAdjacentHTML("beforeend", ic);
      mi.appendChild(lb);
      menu.appendChild(mi);
    });
  }

  // 统计数值
  const totalCount = curSec.items.length;
  const installedCount = curSec.items.filter((item) => item.enabled).length;

  if ($("skillsTotalCount")) $("skillsTotalCount").textContent = `技能 ${totalCount}`;
  if ($("skillsInstalledLabel")) $("skillsInstalledLabel").textContent = `已安装 ${installedCount}`;

  renderSkillsList();

  if (!skillsEventsWired) {
    initSkillsEvents();
    skillsEventsWired = true;
  }
}

function renderSkillsList() {
  closeSkillEditor(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  const curSec = getActiveSkillSection();
  const listEl = $("skillsList");
  if (!listEl) return;

  listEl.replaceChildren();

  const query = skillSearchQuery.trim().toLowerCase();
  const filtered = curSec.items.filter((item) => {
    if (!query) return true;
    return item.name.toLowerCase().includes(query) || (item.description && item.description.toLowerCase().includes(query));
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "skill-empty-row";
    empty.textContent = query ? "未找到匹配技能" : "当前作用域下暂无技能";
    listEl.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "skill-item-row";
    row.dataset.path = s.path;
    row.dataset.name = s.name;

    // 左侧图标徽标
    const badge = document.createElement("div");
    badge.className = "skill-badge";
    badge.innerHTML = icon("skills", 16);

    // 中间信息区
    const info = document.createElement("div");
    info.className = "skill-info";
    const titleRow = document.createElement("div");
    titleRow.className = "skill-title-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "skill-name";
    nameSpan.textContent = s.name;
    titleRow.appendChild(nameSpan);

    if (s.provider && s.provider !== "native") {
      const tag = document.createElement("span");
      tag.className = "skill-provider-tag";
      tag.textContent = s.provider;
      titleRow.appendChild(tag);
    }

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = s.description || "暂无描述";
    desc.title = s.description || s.name;

    info.appendChild(titleRow);
    info.appendChild(desc);

    // 右侧控制区（Toggle 开关 + Trash 删除）
    const controls = document.createElement("div");
    controls.className = "skill-controls";

    const toggle = document.createElement("div");
    toggle.className = "tg" + (s.enabled ? " on" : "");
    toggle.title = s.enabled ? "已启用，点击禁用" : "已禁用，点击启用";
    toggle.appendChild(document.createElement("i"));

    toggle.onclick = (e) => {
      e.stopPropagation();
      const nextEnabled = !s.enabled;
      s.enabled = nextEnabled;
      toggle.classList.toggle("on", nextEnabled);
      toggle.title = nextEnabled ? "已启用，点击禁用" : "已禁用，点击启用";
      const sec = getActiveSkillSection();
      const instCount = sec.items.filter((item) => item.enabled).length;
      if ($("skillsInstalledLabel")) $("skillsInstalledLabel").textContent = `已安装 ${instCount}`;
      send({ type: "asset_skill_toggle", name: s.name, enabled: nextEnabled });
    };

    const trash = document.createElement("button");
    trash.type = "button";
    trash.className = "skill-trash-btn";
    trash.title = "删除技能";
    trash.innerHTML = icon("trash", 14);
    trash.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`确定彻底删除技能 "${s.name}" 吗？此操作将从磁盘移除该技能文件。`)) {
        send({ type: "asset_skill_delete", path: s.path });
      }
    };

    controls.appendChild(toggle);
    controls.appendChild(trash);

    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(controls);
    row.appendChild(caret);
    row.onclick = () => toggleSkillEditor(row, s);
    listEl.appendChild(row);
  }
}

function initSkillsEvents() {
  wireSel("skillScopeSel", (mi) => {
    skillScope = mi.dataset.scope;
    renderSkillsPage();
  });

  const searchInput = $("skillsSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      skillSearchQuery = e.target.value;
      renderSkillsList();
    });
  }

  const refreshBtn = $("skillsRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spin");
      send({ type: "list_agent_assets" });
      setTimeout(() => refreshBtn.classList.remove("spin"), 500);
    });
  }

  wireSel("skillsMoreSel", (mi) => {
    if (mi.id === "miOpenSkillsDir") {
      const curSec = getActiveSkillSection();
      if (curSec?.dir) send({ type: "open_folder", path: curSec.dir });
    } else if (mi.id === "miEnableAllSkills") {
      const curSec = getActiveSkillSection();
      for (const s of curSec.items) {
        if (!s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: true });
      }
    } else if (mi.id === "miDisableAllSkills") {
      const curSec = getActiveSkillSection();
      for (const s of curSec.items) {
        if (s.enabled) send({ type: "asset_skill_toggle", name: s.name, enabled: false });
      }
    }
  });

  const newBtn = $("skillsNewBtn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      const name = prompt("请输入新技能名称（英文小写、数字、下划线或连字符）：");
      if (!name || !name.trim()) return;
      const cleanName = name.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(cleanName)) {
        toast("名称格式无效，仅允许小写字母、数字、-、_");
        return;
      }
      const curSec = getActiveSkillSection();
      const parts = curSec.scope.includes(":")
        ? { scope: curSec.scope.split(":")[0], cwd: curSec.scope.slice(curSec.scope.indexOf(":") + 1) }
        : { scope: curSec.scope };
      send({ type: "asset_file_create", kind: "skill", name: cleanName, ...parts });
    });
  }
}

// 当前向下延展的技能行；延展区即该行的行内编辑器（textarea + 操作行），同记忆页模式
let skillOpenRow = null;
function closeSkillEditor() {
  if (!skillOpenRow) return;
  skillOpenRow.classList.remove("on");
  skillOpenRow.nextElementSibling?.remove(); // .mem-expand
  skillOpenRow = null;
  skillEditingPath = null;
}
// 点击技能行：该行向下延展出编辑区；再次点击收起，点其他行则切换
function toggleSkillEditor(row, skill) {
  if (skillOpenRow === row) {
    closeSkillEditor();
    return;
  }
  closeSkillEditor();
  row.classList.add("on");
  const exp = document.createElement("div");
  exp.className = "mem-expand";
  exp.innerHTML =
    '<div class="mem-exp-head"><span>编辑技能</span><span class="sub" id="skEditPath"></span><span class="sp"></span><button type="button" class="save-btn">收起</button></div>' +
    '<div class="sem-body"><textarea id="skEditText" spellcheck="false" placeholder="在此编辑 SKILL.md 内容..."></textarea></div>' +
    '<div class="sem-foot"><span class="sem-status" id="skEditStatus"></span><span class="sp"></span><button type="button" class="confirm-btn danger" id="skEditDelete">删除</button><button type="button" class="confirm-btn" id="skEditSave">保存</button></div>';
  exp.querySelector(".save-btn").onclick = (e) => {
    e.stopPropagation();
    closeSkillEditor();
  };
  exp.querySelector("#skEditPath").textContent = skill.path;
  exp.querySelector("#skEditText").value = "读取中…";
  exp.querySelector("#skEditSave").onclick = () => {
    if (!skillEditingPath) return;
    if ($("skEditStatus")) $("skEditStatus").textContent = "保存中…";
    send({ type: "asset_file_write", kind: "skill", path: skillEditingPath, content: $("skEditText").value });
  };
  exp.querySelector("#skEditDelete").onclick = () => {
    if (!skillEditingPath) return;
    if (confirm(`确定删除技能 "${skill.name}" 吗？此操作不可撤销。`)) {
      send({ type: "asset_skill_delete", path: skillEditingPath });
      closeSkillEditor();
    }
  };
  row.after(exp);
  skillOpenRow = row;
  skillEditingPath = skill.path;
  send({ type: "asset_file_read", kind: "skill", path: skill.path });
}
