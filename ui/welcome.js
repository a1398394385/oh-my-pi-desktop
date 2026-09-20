// 新建会话页（欢迎页）：延展卡片 + 统一输入框组件挂载 + 项目/分支选择。
import { $, S, send, toast, invoke, diskProjects } from "./core.js";
import { modelNames, modelEfforts, setApprovalModeUi, renderComposerBar, resizeInput, updateSendReady } from "./composer.js";
import { closeAllMenus, updateRailVisibility } from "./shell.js";

function updateGreeting() {
  const h = new Date().getHours();
  let g = "下午好呀，接下来交给我吧";
  if (h >= 5 && h < 11) g = "早上好呀，接下来交给我吧";
  else if (h >= 11 && h < 14) g = "中午好呀，接下来交给我吧";
  else if (h >= 14 && h < 19) g = "下午好呀，接下来交给我吧";
  else g = "晚上好呀，接下来交给我吧";
  const el = $("welcomeTitle");
  if (el) el.textContent = g;
}

export function getAvailableProjects() {
  const removedSet = new Set(S.removedProjects);
  const sessionsOf = new Map(diskProjects.map((p) => [p.cwd, p.sessions]));
  // 顺序 = omp-desktop.json allProjects 的手工/自动发现顺序；磁盘上兜底并入的新项目（旧宿主）按磁盘序缀尾
  const known = [...new Set([...S.allProjects, ...diskProjects.map((p) => p.cwd)])];
  return known
    .filter((cwd) => !removedSet.has(cwd))
    .map((cwd) => ({ cwd, sessions: sessionsOf.get(cwd) ?? [] }));
}

export function setWelcomeProject(cwd) {
  if (!cwd) {
    const avail = getAvailableProjects();
    cwd = avail[0]?.cwd || diskProjects[0]?.cwd || "/";
  }
  S.newSessionProject = cwd;
  try {
    localStorage.setItem("omp-new-project", cwd);
  } catch {}
  const segs = cwd.split("/").filter(Boolean);
  const name = segs[segs.length - 1] || cwd;
  if ($("wbProjectName")) $("wbProjectName").textContent = name;
  if ($("wbProjectBtn")) $("wbProjectBtn").title = `项目目录: ${cwd}`;

  // 查 git 分支
  S.newSessionIsGit = false;
  S.newSessionBranch = "";
  S.newSessionBranches = [];
  updateWelcomeGitUI();
  send({ type: "get_git_branches", cwd });
}

export function updateWelcomeGitUI() {
  const btn = $("wbBranchBtn");
  if (!btn) return;
  if (S.newSessionIsGit) {
    btn.classList.remove("hidden");
    $("wbBranchName").textContent = S.newSessionBranch || "main";
    btn.title = `Git 分支: ${S.newSessionBranch || "main"}`;
  } else {
    btn.classList.add("hidden");
  }
}

export function getSupportedThinkingForModel(modelId) {
  const efforts = modelEfforts.get(modelId) ?? [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

// force = 点新建/配置下发刷新：模型与档位回到配置文件默认（上次手选不跨"点新建"保留）；
// 非 force 只做兜底（当前值缺失或不在目录时才补），欢迎页停留期间的手选不被重绘重置
export function initNewSessionModel(force = false) {
  if (force && S.defaultModelCfg && modelNames.has(S.defaultModelCfg)) {
    S.newSessionModel = S.defaultModelCfg;
  } else if (!S.newSessionModel || !modelNames.has(S.newSessionModel)) {
    const saved = localStorage.getItem("omp-new-model");
    if (saved && modelNames.has(saved)) {
      S.newSessionModel = saved;
    } else {
      const all = Array.from(modelNames.keys());
      const glm = all.find((id) => id.toLowerCase().includes("glm"));
      S.newSessionModel = glm || all[0] || "";
    }
  }
  const validLevels = getSupportedThinkingForModel(S.newSessionModel);
  // 档位来源优先级：force 且有配置默认 → 配置原文（"auto"/档位）；否则上次值/本地记忆/auto
  let th = force && S.defaultThinkingCfg
    ? S.defaultThinkingCfg
    : S.newSessionThinking || localStorage.getItem("omp-new-thinking") || "auto";
  if (!validLevels.includes(th)) {
    th = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
  }
  S.newSessionThinking = th;
}

export function showWelcomeScreen(preferredCwd) {
  // renderChat 每次重绘都会调到本函数：已在欢迎页时走轻量路径，不重置输入、不关菜单、不重拉分支
  const alreadyOpen = S.isCreatingNew && !$("welcomeScreen")?.classList.contains("hidden");
  S.isCreatingNew = true;
  S.activePath = null;
  updateGreeting();
  if (!alreadyOpen) {
    send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
    S.newSessionDirty = false; // 点新建：手选标记清零，模型/档位回到配置文件默认
    initNewSessionModel(true);
  }

  $("stream")?.classList.add("hidden");
  $("statusCard")?.classList.add("hidden");
  $("capsule")?.classList.add("hidden");
  document.querySelector(".dock")?.classList.add("hidden");

  // 将统一的输入框组件挂载进欢迎页延展卡片内部（外卡单一边框勾勒整体轮廓）
  const composer = $("composer");
  const wbBackCard = $("wbBackCard");
  if (composer && wbBackCard && !wbBackCard.contains(composer)) {
    wbBackCard.appendChild(composer);
  }
  composer?.classList.add("in-welcome");

  $("welcomeScreen")?.classList.remove("hidden");
  $("chatTitle").textContent = "新建任务";

  const targetProject = preferredCwd || S.newSessionProject || localStorage.getItem("omp-new-project") || (diskProjects[0]?.cwd);
  // 项目未变化时跳过：避免清空分支状态导致选择器闪动、重复发 get_git_branches
  if (!alreadyOpen || targetProject !== S.newSessionProject) setWelcomeProject(targetProject);
  initNewSessionModel();
  setApprovalModeUi(S.approvalMode);
  renderComposerBar();

  if (alreadyOpen) return;

  const input = $("input");
  if (input) {
    input.placeholder = "使用 @ 添加上下文，使用 / 选择命令或能力";
    input.value = "";
    resizeInput();
    updateSendReady();
    setTimeout(() => input.focus(), 50);
  }
  closeAllMenus();
}

export function hideWelcomeScreen() {
  S.isCreatingNew = false;
  $("welcomeScreen")?.classList.add("hidden");
  $("stream")?.classList.remove("hidden");

  // 将统一的输入框组件挂载回底部 dock
  const composer = $("composer");
  const dock = document.querySelector(".dock");
  if (composer && dock && !dock.contains(composer)) {
    dock.appendChild(composer);
  }
  composer?.classList.remove("in-welcome");
  dock?.classList.remove("hidden");
  updateRailVisibility();

  const input = $("input");
  if (input) {
    input.placeholder = "发消息…（Enter 发送）";
  }
}

function renderWbProjectList(filter = "") {
  const listEl = $("wbProjList");
  if (!listEl) return;
  listEl.innerHTML = "";

  const available = getAvailableProjects();
  const kw = filter.trim().toLowerCase();
  const matched = kw
    ? available.filter((p) => {
        const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
        return name.toLowerCase().includes(kw) || p.cwd.toLowerCase().includes(kw);
      })
    : available;

  if (matched.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wb-proj-empty";
    empty.textContent = "无匹配工作区";
    listEl.appendChild(empty);
    return;
  }

  for (const p of matched) {
    const item = document.createElement("div");
    item.className = "wb-proj-item" + (p.cwd === S.newSessionProject ? " selected" : "");
    item.title = p.cwd;

    const ic = document.createElement("span");
    ic.className = "wb-proj-item-icon";
    ic.innerHTML = icon("folderLine", 14);

    const nameEl = document.createElement("span");
    nameEl.className = "wb-proj-item-name";
    const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
    nameEl.textContent = name;

    item.append(ic, nameEl);
    item.onclick = (e) => {
      e.stopPropagation();
      setWelcomeProject(p.cwd);
      closeAllMenus();
    };
    listEl.appendChild(item);
  }
}

// 绑定延展卡片中的项目与分支选择事件
export function initWelcome() {
  $("wbProjectBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("wbProjectMenu");
    const backCard = document.querySelector(".wb-back-card");
    if (menu.classList.contains("open")) return closeAllMenus();
    closeAllMenus();
    backCard?.classList.add("menu-open");
    $("wbProjectBtn").classList.add("active");
    menu.style.left = $("wbProjectBtn").offsetLeft + "px";
    // 向上弹出：菜单底边贴着胶囊顶边上方 4px
    menu.style.top = "auto";
    menu.style.bottom = (backCard.clientHeight - $("wbProjectBtn").offsetTop + 4) + "px";

    const searchInput = $("wbProjSearchInput");
    if (searchInput) searchInput.value = "";
    renderWbProjectList("");
    menu.classList.add("open");

    setTimeout(() => searchInput?.focus(), 40);
  });

  $("wbProjSearchInput")?.addEventListener("input", (e) => {
    renderWbProjectList(e.target.value);
  });

  $("wbProjSearchInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const firstItem = $("wbProjList")?.querySelector(".wb-proj-item");
      if (firstItem) firstItem.click();
    } else if (e.key === "Escape") {
      closeAllMenus();
    }
  });

  $("wbProjectMenu")?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  $("wbProjOpenFolder")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    if (invoke) {
      invoke("plugin:dialog|open", { options: { directory: true, title: "选择项目文件夹" } })
        .then((p) => {
          if (p) {
            send({ type: "add_project", cwd: p });
            setWelcomeProject(p);
          }
        })
        .catch((err) => {
          console.warn("打开文件夹失败:", err);
        });
    } else {
      const manual = prompt("请输入项目文件夹绝对路径：");
      if (manual && manual.trim()) {
        const p = manual.trim();
        send({ type: "add_project", cwd: p });
        setWelcomeProject(p);
      }
    }
  });

  $("wbProjRemote")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toast("远程连接功能即将推出");
    closeAllMenus();
  });

  $("wbProjNoProject")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toast("不在项目中工作功能即将推出");
    closeAllMenus();
  });

  $("wbProjClear")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toast("不在项目中工作功能即将推出");
  });

  $("wbBranchBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("wbBranchMenu");
    const backCard = document.querySelector(".wb-back-card");
    if (menu.classList.contains("open")) return closeAllMenus();
    closeAllMenus();
    backCard?.classList.add("menu-open");
    $("wbBranchBtn").classList.add("active");
    menu.style.left = $("wbBranchBtn").offsetLeft + "px";
    // 向上弹出：菜单底边贴着胶囊顶边上方 4px
    menu.style.top = "auto";
    menu.style.bottom = (backCard.clientHeight - $("wbBranchBtn").offsetTop + 4) + "px";
    menu.innerHTML = "";
    for (const b of S.newSessionBranches) {
      const mi = document.createElement("div");
      mi.className = "mi";
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = b === S.newSessionBranch ? "✓" : "";
      // 分支图标与分支选择胶囊同款（branch），保持全局图标风格一致
      const ic = document.createElement("span");
      ic.className = "mi-ic";
      ic.style.color = "var(--dim)";
      ic.innerHTML = icon("branch", 14);
      mi.append(ck, ic, document.createTextNode(b));
      mi.onclick = () => {
        if (b !== S.newSessionBranch) {
          send({ type: "switch_git_branch", cwd: S.newSessionProject, branch: b });
        }
        closeAllMenus();
      };
      menu.appendChild(mi);
    }
    menu.classList.add("open");
  });
}
