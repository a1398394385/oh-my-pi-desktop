// 设置中心框架：外观偏好（字体/字号/开关）、宿主设置快照、Profile 切换、
// 页面路由（switchSetPage）与全部设置页事件绑定（initSettings）；资产页聚合（renderAssetPages）。
import { $, S, send, toast, inputEl, openSessions, uiPrefs, renderAll } from "../core.js";
import { closeAllMenus, applyTheme } from "../shell.js";
import { renderChat } from "../chat.js";
import { closeMemoryRow, toggleMemoryRow } from "./memory.js";
import { fillAssetList, assetTitle, renderAssetPage } from "./agents.js";
import { renderSkillsPage } from "./skills.js";
import { renderMcpPage } from "./mcp.js";
import { renderModelPage } from "./models.js";

const UI_PREF_KEY = "omp-ui-settings";
export const FONT_LABELS = {
  default: "系统默认",
  pingfang: "苹方 / PingFang SC",
  songti: "宋体 / Songti SC",
  kaiti: "楷体 / KaiTi SC",
  heiti: "黑体 / Heiti SC",
  mono: "等宽",
};
export const FONT_STACKS = {
  default: "var(--sans)",
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
export const PROV_IC = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

export function saveUiPrefs() {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(uiPrefs));
  } catch {}
}
export function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}
export function setTg(el, on) {
  if (el) el.classList.toggle("on", !!on);
}
export function applyHostSettings(s) {
  if (!s) return;
  S.hostSettings = s;
  const active = document.activeElement;
  const env = S.hostSettings.desktopEnv || {};
  const fill = (id, val) => {
    const el = $(id);
    if (!el || active === el) return;
    el.value = val || "";
  };
  fill("proxyInput", env.httpProxy);
  fill("noProxyInput", env.noProxy);
  fill("caInput", env.caCerts);
  fill("askTimeoutInput", S.hostSettings.askTimeout ? String(S.hostSettings.askTimeout) : "");
  setTg($("tgSleep"), S.hostSettings.sleepPrevention && S.hostSettings.sleepPrevention !== "off");
  setTg($("tgComputer"), S.hostSettings.computerEnabled);
  setTg($("tgMemory"), S.hostSettings.memoryBackend && S.hostSettings.memoryBackend !== "off");
  if (S.hostSettings.activeProfile) {
    renderProfileSelector(S.hostSettings.activeProfile, S.hostSettings.availableProfiles, S.hostSettings.profileAgentDir);
  }
}
function renderProfileSelector(activeProfile, profiles, profileAgentDir) {
  if (!activeProfile) return;
  const footEl = $("setFootProfile");
  if (footEl) footEl.textContent = activeProfile;
  // 主页面左下角同步显示当前 profile 名
  const sideName = $("sideProfileName");
  if (sideName) sideName.textContent = activeProfile;
  const pathDesc = $("profilePathDesc");
  if (pathDesc && profileAgentDir) {
    pathDesc.textContent = `当前目录: ${profileAgentDir}`;
  }
  const sel = $("profileSel");
  if (sel) {
    for (const n of sel.childNodes) {
      if (n.nodeType === 3) {
        n.textContent = activeProfile + " ";
        break;
      }
    }
  }
  const menu = $("profileMenu");
  if (menu && Array.isArray(profiles)) {
    menu.replaceChildren();
    for (const p of profiles) {
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.profile = p;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = p === activeProfile ? "✓" : "";
      mi.appendChild(ck);
      mi.appendChild(document.createTextNode(p === "default" ? "default (全局默认)" : p));
      menu.appendChild(mi);
    }
  }
}
function switchProfile(name) {
  const target = String(name || "").trim();
  if (!target) return;
  toast(`正在切换至 Profile: ${target}…`);
  openSessions.clear();
  S.activePath = null;
  S.selectedSubagent = null;
  S.selectedFile = null;
  renderAll();
  send({ type: "switch_profile", profile: target });
}
export function applyHostReadySettings(s) {
  applyHostSettings(s);
  if (!s) return;
  uiPrefs.showThinking = !s.hideThinkingBlock;
  saveUiPrefs();
  applyAppearance();
  syncSettingsControls();
}
export function syncSettingsControls() {
  if ($("uiFsVal")) $("uiFsVal").innerHTML = uiPrefs.uiFontSize + " <i>px</i>";
  if ($("codeFsVal")) $("codeFsVal").innerHTML = uiPrefs.codeFontSize + " <i>px</i>";
  setTg($("tgLineNo"), uiPrefs.lineNumbers);
  setTg($("tgWrap"), uiPrefs.codeWrap);
  setTg($("tgThinking"), uiPrefs.showThinking);
  const fontSel = $("fontSel");
  if (fontSel) {
    for (const n of fontSel.childNodes) {
      if (n.nodeType === 3) {
        n.textContent = (FONT_LABELS[uiPrefs.uiFont] || "系统默认") + " ";
        break;
      }
    }
    for (const mi of $("fontMenu").querySelectorAll(".mi")) {
      const ck = mi.querySelector(".ck");
      if (ck) ck.textContent = mi.dataset.font === uiPrefs.uiFont ? "✓" : "";
    }
  }
  if (!S.hostSettings) return;
  setTg($("tgSleep"), S.hostSettings.sleepPrevention && S.hostSettings.sleepPrevention !== "off");
  setTg($("tgComputer"), S.hostSettings.computerEnabled);
  setTg($("tgMemory"), S.hostSettings.memoryBackend && S.hostSettings.memoryBackend !== "off");
  const env = S.hostSettings.desktopEnv || {};
  if ($("proxyInput")) $("proxyInput").value = env.httpProxy || "";
  if ($("noProxyInput")) $("noProxyInput").value = env.noProxy || "";
  if ($("caInput")) $("caInput").value = env.caCerts || "";
  if ($("askTimeoutInput")) $("askTimeoutInput").value = S.hostSettings.askTimeout ? String(S.hostSettings.askTimeout) : "";
}
export function settingsOpen() {
  return !$("settings").classList.contains("hidden");
}
export function openSettings(pageId) {
  closeAllMenus();
  inputEl.blur();
  $("settings").classList.remove("hidden");
  switchSetPage(pageId || "pg-general");
  send({ type: "get_settings" });
  send({ type: "get_models_catalog" });
  send({ type: "list_agent_assets" });
  send({ type: "get_usage_stats" });
}
export function closeSettings() {
  closeAllMenus();
  $("settings").classList.add("hidden");
}
export function switchSetPage(id) {
  for (const x of document.querySelectorAll(".set-item")) x.classList.toggle("on", x.dataset.page === id);
  for (const p of document.querySelectorAll(".set-page")) p.classList.toggle("hidden", p.id !== id);
  $("setBody").scrollTop = 0;
  if (id === "pg-skills") renderSkillsPage();
  if (id === "pg-mcp") renderMcpPage();
}
export function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "srow";
  const tx = document.createElement("div");
  tx.className = "srow-tx";
  const span = document.createElement("span");
  span.textContent = text;
  tx.appendChild(span);
  row.appendChild(tx);
  return row;
}

export function wireSel(selId, onPick) {
  const sel = $(selId);
  if (!sel) return;
  const menu = sel.querySelector(".menu");
  sel.addEventListener("click", (e) => {
    e.stopPropagation();
    const was = menu.classList.contains("open");
    closeAllMenus();
    if (!was) menu.classList.add("open");
  });
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    const mi = e.target.closest(".mi");
    if (!mi || mi.classList.contains("disabled")) return;
    onPick(mi);
    closeAllMenus();
  });
}
export function wireToggle(id, apply) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    apply(!el.classList.contains("on"));
  });
}
function stepFont(key, delta, min, max, labelId) {
  uiPrefs[key] = Math.min(max, Math.max(min, uiPrefs[key] + delta));
  saveUiPrefs();
  applyAppearance();
  $(labelId).innerHTML = uiPrefs[key] + " <i>px</i>";
}

// 资产页聚合：记忆/命令/钩子/子智能体/技能/MCP 列表全量重建（agent_assets 回包后）
export function renderAssetPages() {
  const a = S.agentAssets;
  if (!a) return;
  closeMemoryRow(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  // 记忆列表：标题优先展示项目末级目录名（host 端按 cwd 编码匹配），点击行向下延展出详情
  fillAssetList("memoryList", a.memories, (tx, m) => assetTitle(tx, m.project ?? m.name, m.path));
  const memRows = $("memoryList").querySelectorAll(".srow");
  a.memories.forEach((m, i) => {
    const row = memRows[i];
    if (!row) return;
    row.classList.add("mem-row");
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");
    row.appendChild(caret);
    row.onclick = () => toggleMemoryRow(row, m);
  });
  fillAssetList("commandsList", a.commands, (tx, m) => assetTitle(tx, "/" + m.name, m.path));
  fillAssetList("hooksList", a.hooks, (tx, m) => assetTitle(tx, m.name, (m.phase || "") + " · " + m.path));
  renderAssetPage("agent");
  renderSkillsPage();
  renderMcpPage();
}

export function initSettings() {
  // 设置页右上角手动刷新(已取消 host 自动监听):模型页重载配置+目录,资产页重拉磁盘列表
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".pg-refresh");
    if (!btn) return;
    if (btn.dataset.refresh === "models") {
      send({ type: "reload_settings" });
      send({ type: "get_models_catalog" });
    } else {
      send({ type: "list_agent_assets" });
    }
    btn.classList.add("spin");
    setTimeout(() => btn.classList.remove("spin"), 500);
  });

  $("settingsBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    openSettings();
  });
  $("setBack").addEventListener("click", closeSettings);
  $("setNav").addEventListener("click", (e) => {
    const it = e.target.closest(".set-item");
    if (!it) return;
    closeAllMenus();
    switchSetPage(it.dataset.page);
  });
  wireSel("profileSel", (mi) => {
    const target = mi.dataset.profile;
    if (target && target !== S.hostSettings?.activeProfile) {
      switchProfile(target);
    }
  });
  const newProfileBtn = $("newProfileBtn");
  if (newProfileBtn) {
    newProfileBtn.addEventListener("click", () => {
      closeAllMenus();
      const input = window.prompt("请输入新 Profile 名称（仅支持小写字母、数字、短横线、下划线）：");
      if (!input) return;
      const name = input.trim();
      if (!name) return;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
        toast("Profile 名称不合法：仅支持字母、数字、点、短横线、下划线");
        return;
      }
      switchProfile(name);
    });
  }
  wireSel("themeSel", (mi) => applyTheme(mi.dataset.th));
  wireSel("genThemeSel", (mi) => applyTheme(mi.dataset.th));
  wireSel("fontSel", (mi) => {
    uiPrefs.uiFont = mi.dataset.font;
    saveUiPrefs();
    applyAppearance();
    syncSettingsControls();
  });
  wireSel("langSel", (mi) => {
    if (mi.dataset.lang !== "zh-CN") return toast("目前仅支持简体中文");
  });
  wireSel("codeLightSel", () => toast("浅色代码主题目前固定 GitHub Light"));
  wireSel("codeDarkSel", () => toast("深色代码主题目前固定 GitHub Dark"));
  wireToggle("tgLineNo", (on) => {
    uiPrefs.lineNumbers = on;
    saveUiPrefs();
    applyAppearance();
    setTg($("tgLineNo"), on);
  });
  wireToggle("tgWrap", (on) => {
    uiPrefs.codeWrap = on;
    saveUiPrefs();
    applyAppearance();
    setTg($("tgWrap"), on);
  });
  wireToggle("tgThinking", (on) => {
    uiPrefs.showThinking = on;
    saveUiPrefs();
    applyAppearance();
    setTg($("tgThinking"), on);
    send({ type: "set_setting", key: "hideThinkingBlock", value: !on });
    renderChat();
  });
  wireToggle("tgSleep", (on) => {
    setTg($("tgSleep"), on);
    send({ type: "set_setting", key: "power.sleepPrevention", value: on ? "system" : "off" });
  });
  wireToggle("tgComputer", (on) => {
    setTg($("tgComputer"), on);
    send({ type: "set_setting", key: "computer.enabled", value: on });
    toast("已写入。电脑控制对之后新建的会话生效。");
  });
  wireToggle("tgMemory", (on) => {
    setTg($("tgMemory"), on);
    send({ type: "set_setting", key: "memory.backend", value: on ? "local" : "off" });
  });
  $("uiFsMinus")?.addEventListener("click", () => stepFont("uiFontSize", -1, 11, 18, "uiFsVal"));
  $("uiFsPlus")?.addEventListener("click", () => stepFont("uiFontSize", 1, 11, 18, "uiFsVal"));
  $("codeFsMinus")?.addEventListener("click", () => stepFont("codeFontSize", -1, 10, 18, "codeFsVal"));
  $("codeFsPlus")?.addEventListener("click", () => stepFont("codeFontSize", 1, 10, 18, "codeFsVal"));
  function saveDesktopField(field, inputId) {
    const env = { ...(S.hostSettings?.desktopEnv || { httpProxy: "", noProxy: "", caCerts: "" }), [field]: $(inputId).value.trim() };
    send({ type: "set_desktop_env", ...env });
  }
  $("proxySave")?.addEventListener("click", () => saveDesktopField("httpProxy", "proxyInput"));
  $("noProxySave")?.addEventListener("click", () => saveDesktopField("noProxy", "noProxyInput"));
  $("caSave")?.addEventListener("click", () => saveDesktopField("caCerts", "caInput"));
  $("askTimeoutSave")?.addEventListener("click", () => {
    const raw = parseFloat($("askTimeoutInput").value);
    const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    send({ type: "set_setting", key: "ask.timeout", value: secs });
    toast(`提问超时时间已保存：${secs} 秒${secs === 0 ? "（永不超时）" : ""}`);
  });
  $("addProviderBtn")?.addEventListener("click", () => {
    S.mpAddView = true;
    S.mpRolesView = false;
    // 进入添加视图时拉最新凭证数,登出后「已配置」回显即时收敛
    send({ type: "get_all_providers" });
    renderModelPage();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      $("settings").classList.contains("hidden") ? openSettings() : closeSettings();
    } else if (e.key === "Escape" && settingsOpen()) {
      e.preventDefault();
      closeSettings();
    }
  });
}
