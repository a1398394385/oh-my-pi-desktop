// 设置·模型页：已认证供应商分组列表 + 右卡模型启停 + 供应商配额段 + 模型角色（@role）分配。
// icon() 是 icons.js（普通 script）暴露的全局函数，与 settings/agents.js 用法一致。
import { $, S, send, toast } from "../core.js";
import { closeAllMenus } from "../shell.js";
import { PROV_IC } from "./index.js";
import { renderAddProviderView, confirmDialog } from "./providers.js";

// 内置角色的用途说明（自定义角色显示通用文案；名称/tag 以 host 传的底座元数据为准）
const ROLE_DESC = {
  default: "新会话与未指定角色任务的默认模型",
  smol: "快速轻量任务：标题生成、上下文预扫描等",
  slow: "深度思考（Thinking）链路使用的模型",
  vision: "图像 / 视觉理解任务",
  plan: "规划（Architect）模式使用的模型",
  commit: "生成提交信息的模型",
  tiny: "在线标题、记忆、分类等微型任务",
  task: "子智能体（subagent）默认模型",
  advisor: "子智能体的第二意见评审模型",
};

export function renderModelPage() {
  const list = $("mpList");
  const detail = $("mpDetail");
  if (!list || !detail) return;
  if (S.mpAddView) {
    renderAddProviderView();
    return;
  }
  const groups = new Map();
  for (const m of S.modelCatalog) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  if (!S.mpRolesView && (!S.selectedProvider || !groups.has(S.selectedProvider))) {
    S.selectedProvider = groups.keys().next().value ?? null;
  }
  list.innerHTML = "";
  // 模型角色入口：全局 @role → 模型分配，置于供应商列表之上
  const roleRow = document.createElement("div");
  roleRow.className = "pv" + (S.mpRolesView ? " on" : "");
  const roleIc = document.createElement("span");
  roleIc.className = "pv-ic";
  roleIc.innerHTML = icon("sliders", 14);
  const roleNm = document.createElement("span");
  roleNm.className = "pv-name";
  roleNm.textContent = "模型角色";
  roleRow.append(roleIc, roleNm);
  roleRow.onclick = () => {
    S.mpAddView = false;
    S.mpRolesView = true;
    send({ type: "get_model_roles" });
    renderModelPage();
  };
  list.appendChild(roleRow);
  const roleDiv = document.createElement("div");
  roleDiv.className = "pd-div mp-div";
  list.appendChild(roleDiv);
  const pipe = document.createElement("div");
  pipe.className = "set-sec mp-grp";
  pipe.textContent = "已认证供应商";
  list.appendChild(pipe);
  if (!groups.size) {
    const empty = document.createElement("div");
    empty.className = "pv";
    empty.textContent = "暂无可用模型";
    list.appendChild(empty);
    if (S.mpRolesView) {
      renderRolesView();
      return;
    }
    const hint = document.createElement("div");
    hint.className = "set-group-desc";
    hint.textContent = "宿主未连接或没有已认证模型。";
    detail.replaceChildren(hint);
    return;
  }
  // 分组:登录/API key 凭证在上,models.yml 配置在下,中间横线 + 组标识
  const credEntries = [];
  const configEntries = [];
  for (const entry of groups) {
    (entry[1][0]?.authSource === "config" ? configEntries : credEntries).push(entry);
  }
  const renderGroup = (label, entries) => {
    if (!entries.length) return;
    if (label) {
      const g = document.createElement("div");
      g.className = "set-sec mp-grp";
      g.textContent = label;
      list.appendChild(g);
    }
    for (const [prov, models] of entries) {
      const row = document.createElement("div");
      row.className = "pv" + (!S.mpRolesView && prov === S.selectedProvider ? " on" : "");
      const ic = document.createElement("span");
      ic.className = "pv-ic";
      ic.textContent = PROV_IC[prov] || "✦";
      row.appendChild(ic);
      const nm = document.createElement("span");
      nm.className = "pv-name";
      nm.textContent = prov;
      row.appendChild(nm);
      if (models.some((m) => m.enabled)) {
        const dot = document.createElement("span");
        dot.className = "dot";
        row.appendChild(dot);
      }
      row.onclick = () => {
        S.mpAddView = false;
        S.mpRolesView = false;
        S.selectedProvider = prov;
        renderModelPage();
      };
      list.appendChild(row);
    }
  };
  renderGroup("", credEntries);
  if (credEntries.length && configEntries.length) {
    const hr = document.createElement("div");
    hr.className = "pd-div mp-div";
    list.appendChild(hr);
  }
  renderGroup("配置文件", configEntries);
  if (S.mpRolesView) {
    renderRolesView();
    return;
  }
  const models = groups.get(S.selectedProvider) || [];
  const anyOn = models.some((m) => m.enabled);
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const hb = document.createElement("b");
  hb.textContent = (PROV_IC[S.selectedProvider] || "✦") + " " + S.selectedProvider;
  const sp = document.createElement("span");
  sp.className = "sp";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = models.length + " 个模型";
  head.append(hb, sp, tag);
  // 凭证类供应商提供登出（.save-btn 尺寸语言 + danger 变体 hover 变红，与页面按钮风格统一）：
  // 多账号供应商一次登出全部凭证（与 CLI auth-broker logout 行为一致）；
  // config 类（models.yml 手写 apiKey）优先级高于存储凭证，删除凭证无效，不显示按钮
  if (models[0]?.authSource === "cred") {
    const out = document.createElement("button");
    out.type = "button";
    out.className = "save-btn danger";
    out.textContent = "登出";
    out.onclick = async () => {
      const ok = await confirmDialog({
        title: `登出 ${S.selectedProvider}`,
        message: "该供应商的全部账号凭证将被移除，模型从可选列表消失；进行中的会话不受影响。",
        confirmText: "登出",
        danger: true,
      });
      if (!ok) return;
      send({ type: "provider_logout", provider: S.selectedProvider });
      toast("正在登出…");
    };
    head.appendChild(out);
  }
  detail.appendChild(head);
  // 供应商配额:命中 host 侧 60s 缓存,切换供应商即重查
  const limSec = document.createElement("div");
  limSec.id = "mpLimSec";
  limSec.className = "mp-lim";
  limSec.textContent = "配额读取中…";
  detail.appendChild(limSec);
  send({ type: "get_provider_limits", provider: S.selectedProvider });
  const ml = document.createElement("div");
  ml.className = "mp-ml";
  ml.innerHTML = "<span>模型列表</span>";
  detail.appendChild(ml);
  for (const m of models) {
    const row = document.createElement("div");
    row.className = "mp-row";
    const name = document.createElement("span");
    name.textContent = m.name;
    row.appendChild(name);
    if (m.context) {
      const t = document.createElement("span");
      t.className = "tag";
      // 上下文按二进制单位:204800 → 200k、1048576 → 1M
      t.textContent = m.context >= 1048576 ? Math.round(m.context / 1048576) + "M" : m.context >= 1024 ? Math.round(m.context / 1024) + "k" : String(m.context);
      row.appendChild(t);
    }
    if (m.vision) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = "视觉";
      row.appendChild(t);
    }
    const sp2 = document.createElement("span");
    sp2.className = "sp";
    row.appendChild(sp2);
    const tg = document.createElement("div");
    tg.className = "tg" + (m.enabled ? " on" : "");
    tg.innerHTML = "<i></i>";
    tg.onclick = () => {
      if (m.enabled && S.modelCatalog.filter((x) => x.enabled).length <= 1) {
        toast("至少保留一个启用模型");
        return;
      }
      send({ type: "set_enabled_model", id: m.id, enabled: !m.enabled });
    };
    row.appendChild(tg);
    detail.appendChild(row);
  }
  if (!anyOn) {
    const hint = document.createElement("div");
    hint.className = "set-group-desc";
    hint.style.marginTop = "8px";
    hint.textContent = "该供应商下暂无启用模型。";
    detail.appendChild(hint);
  }
}

// 角色选择器当前值显示：未配置 →「默认」；精确匹配目录模型 → 模型名；其余（别名/带级别后缀）→ 原文
function roleSelLabel(role) {
  if (!role.value) return role.id === "default" ? "未设置" : "默认";
  const hit = S.modelCatalog.find((m) => m.id === role.value);
  if (hit) return hit.name;
  return role.value;
}

// 角色行的模型选择器：复用输入框模型菜单的二级级联（一级供应商行 + hover 右弹浮层），
// 交互与 buildModelMenu 同款（180ms 悬停意图延时 / 150ms 宽限关闭 / 右缘越界翻左）。
// 浮层挂在 .sel 下而非一级菜单内——.menu.model 带 overflow-y:auto 会裁掉绝对定位子元素。
// 宽度由 .mp-role-sel / .mp-role-menu 统一，模型配置页所有选择框一致。
function buildRolePicker(role, allModels) {
  const sel = document.createElement("div");
  sel.className = "sel mp-role-sel";
  sel.setAttribute("role", "button");
  const label = document.createElement("span");
  label.textContent = roleSelLabel(role);
  const caret = document.createElement("span");
  caret.className = "caret-svg";
  caret.innerHTML = icon("caret", 12);
  const menu = document.createElement("div");
  menu.className = "menu model mp-role-menu";
  const pick = (value) => {
    if ((role.value ?? null) === value) return;
    send({ type: "set_model_role", role: role.id, value });
  };
  const byProv = new Map();
  for (const m of allModels) {
    if (!byProv.has(m.provider)) byProv.set(m.provider, []);
    byProv.get(m.provider).push(m);
  }
  let flyout = null; // 当前二级浮层
  let hideTimer = null;
  let switchTimer = null; // 行切换悬停意图延时
  const closeFlyout = () => {
    clearTimeout(hideTimer);
    clearTimeout(switchTimer);
    flyout?.remove();
    flyout = null;
    menu.querySelectorAll(".mi.prov.on").forEach((r) => r.classList.remove("on"));
  };
  const armHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(closeFlyout, 150);
  };
  const cancelHide = () => clearTimeout(hideTimer);
  for (const [prov, models] of byProv) {
    const prow = document.createElement("div");
    prow.className = "mi prov";
    prow.appendChild(document.createTextNode(prov));
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.innerHTML = icon("chevronRight", 10);
    prow.appendChild(sub);
    const openFlyout = () => {
      cancelHide();
      closeFlyout();
      prow.classList.add("on");
      flyout = document.createElement("div");
      // 二级浮层不锁宽：按最长模型名动态扩张（CSS nowrap 保证不折行）
      flyout.className = "menu flyout open";
      for (const m of models) {
        const mi = document.createElement("div");
        mi.className = "mi" + (role.value === m.id ? " on" : "");
        const ck = document.createElement("span");
        ck.className = "ck";
        ck.textContent = role.value === m.id ? "✓" : "";
        mi.append(ck, document.createTextNode(m.name));
        mi.addEventListener("click", (e) => {
          e.stopPropagation();
          closeAllMenus();
          pick(m.id);
        });
        flyout.appendChild(mi);
      }
      sel.appendChild(flyout);
      // 坐标为 .sel 相对（offsetParent）：一级菜单下弹对齐行位（两菜单 padding 均 5px，-5 对齐首行），
      // 浮层与一级菜单边框交叠 4px；右缘越界翻到左侧弹出。
      // #setBody 是 overflow-y:auto（横向同被裁），越界判定用其可视右缘而非视口
      flyout.style.top = menu.offsetTop + prow.offsetTop - menu.scrollTop - 5 + "px";
      flyout.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px";
      const bound = sel.closest("#setBody") ?? document.body;
      if (flyout.getBoundingClientRect().right > bound.getBoundingClientRect().right - 8) {
        flyout.style.left = Math.max(0, menu.offsetLeft - flyout.offsetWidth + 4) + "px";
      }
      flyout.addEventListener("mouseenter", () => {
        cancelHide();
        clearTimeout(switchTimer);
      });
      flyout.addEventListener("mouseleave", armHide);
    };
    prow.addEventListener("mouseenter", () => {
      cancelHide();
      if (prow.classList.contains("on")) return;
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => {
        closeFlyout();
        openFlyout();
      }, 180);
    });
    prow.addEventListener("mouseleave", () => clearTimeout(switchTimer));
    prow.addEventListener("click", (e) => {
      e.stopPropagation();
      if (prow.classList.contains("on")) closeFlyout();
      else openFlyout();
    });
    menu.appendChild(prow);
  }
  sel.append(label, caret, menu);
  sel.addEventListener("click", (e) => {
    e.stopPropagation();
    const was = menu.classList.contains("open");
    closeAllMenus();
    if (!was) menu.classList.add("open");
  });
  return sel;
}

// 右卡：模型角色视图（srow 行 + 二级级联模型选择器 + 自定义角色删除按钮）
function renderRolesView() {
  const detail = $("mpDetail");
  if (!detail) return;
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const hb = document.createElement("b");
  hb.textContent = "模型角色";
  const sp = document.createElement("span");
  sp.className = "sp";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = (S.modelRoles?.length ?? 0) + " 个角色";
  head.append(hb, sp, tag);
  detail.appendChild(head);
  const desc = document.createElement("div");
  desc.className = "set-group-desc mp-role-desc";
  desc.textContent = "为不同用途的任务分配模型；未设置时按内置优先级解析。对新会话生效。";
  detail.appendChild(desc);
  // 目录全量（含未启用模型）：角色值可指向任意目录模型，host 校验与底座解析均走 availableModels 全量
  const allModels = S.modelCatalog;
  for (const role of S.modelRoles ?? []) {
    const row = document.createElement("div");
    row.className = "srow mp-role-row";
    const tx = document.createElement("div");
    tx.className = "srow-tx";
    const b = document.createElement("b");
    b.textContent = role.name;
    if (role.tag) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = role.tag;
      b.appendChild(t);
    }
    const span = document.createElement("span");
    const parts = [ROLE_DESC[role.id] ?? "自定义角色"];
    if (role.value && !allModels.some((m) => m.id === role.value)) parts.push(`配置值: ${role.value}`);
    span.textContent = parts.join(" · ");
    tx.append(b, span);
    row.appendChild(tx);
    const ctl = document.createElement("div");
    ctl.className = "srow-ctl";
    ctl.appendChild(buildRolePicker(role, allModels));
    // 按钮列与自定义行的删除按钮同列对齐：内置角色放 X 清除（有值时；= 传 null 回继承默认），
    // 自定义角色放 trash 删除（.skill-trash-btn 全站删除语言；传 null = 从 modelRoles 移除）
    if (role.id in ROLE_DESC) {
      if (role.value) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "mp-role-clear";
        clear.title = "清除选择（继承默认）";
        clear.innerHTML = icon("xmark", 14);
        clear.onclick = (e) => {
          e.stopPropagation();
          send({ type: "set_model_role", role: role.id, value: null });
        };
        ctl.appendChild(clear);
      }
    } else {
      const trash = document.createElement("button");
      trash.type = "button";
      trash.className = "skill-trash-btn";
      trash.title = "删除自定义角色";
      trash.innerHTML = icon("trash", 14);
      trash.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`确定删除自定义角色 "${role.name}" 吗？`)) {
          send({ type: "set_model_role", role: role.id, value: null });
        }
      };
      ctl.appendChild(trash);
    }
    row.appendChild(ctl);
    detail.appendChild(row);
  }
}
