// 输入区（composer）：附件、发送、权限模式（omp 三值）、模型/思考级别菜单、
// 底栏状态条与分级收缩（fitComposerBar）。值域来自宿主下发。
import { $, S, send, toast, inputEl, streamEl, composerEl, modelBtn, thinkBtn, modeBtn, activeOpen } from "./core.js";
import { sendNowQueueMsg, editQueueMsg, dropQueueMsg } from "./core.js";
import { closeAllMenus } from "./shell.js";
import { settingsOpen } from "./settings/index.js";
import { PROV_IC } from "./settings/index.js";
import { getSupportedThinkingForModel } from "./welcome.js";
import { updateBgTaskButton, updateBgSubagentButton } from "./right.js";
import { renderAll } from "./core.js";

// ---------- 发送 / 新建 ----------
// 待发送附件：图片走 ImageContent（base64），文本类文件内联进 prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

function renderAttachRow() {
  const row = $("attachRow");
  row.innerHTML = "";
  for (const f of S.pendingFiles) {
    const chip = document.createElement("span");
    chip.className = "atchip";
    chip.innerHTML = `<span class="at-ic">${f.kind === "image" ? icon("image") : icon("file")}</span><span class="at-name" title="${f.name}">${f.name}</span>`;
    const x = document.createElement("button");
    x.className = "atchip-x";
    x.title = "移除";
    x.textContent = "×";
    x.addEventListener("click", () => {
      S.pendingFiles = S.pendingFiles.filter((it) => it.id !== f.id);
      renderAttachRow();
      updateSendReady();
    });
    chip.appendChild(x);
    row.appendChild(chip);
  }
  row.hidden = S.pendingFiles.length === 0;
}

// 组装随 prompt 下发的附件载荷（发送后由调用方清空 pendingFiles）
function buildAttachPayload() {
  return S.pendingFiles.map((f) =>
    f.kind === "image"
      ? { kind: "image", mime: f.mime, data: f.data }
      : { kind: "text", name: f.name, text: f.data }
  );
}

export function sendPrompt() {
  const text = inputEl.value.trim();
  const files = buildAttachPayload();
  if ((!text && files.length === 0) || S.ws.readyState !== 1) return;

  if (S.isCreatingNew || !activeOpen()) {
    S.pendingNewPrompt = { text, files };
    inputEl.value = "";
    S.pendingFiles = [];
    renderAttachRow();
    resizeInput();
    updateSendReady();
    send({
      type: "create_session",
      cwd: S.newSessionProject || undefined,
      model: S.newSessionModel || undefined,
      thinking: S.newSessionThinking || undefined,
    });
    S.pendingCreate = true;
    return;
  }

  const s = activeOpen();
  if (!s) return;
  // 流式中发送 = 排队（followUp，当前 loop 完自动消费）：只进队列卡，不出气泡、
  // 不截断过程——气泡在「立即发送」转 steer 时才出现并成为分界
  if (s.streaming) {
    s.queued = s.queued ?? [];
    s.queued.push({ text });
  } else {
    s.items.push({ role: "user", text });
  }
  inputEl.value = "";
  S.pendingFiles = [];
  renderAttachRow();
  resizeInput();
  updateSendReady();
  renderAll();
  S.ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
  streamEl.scrollTop = streamEl.scrollHeight;
}

export function createIn(cwd) {
  send(cwd ? { type: "create_session", cwd } : { type: "create_session" });
  S.pendingCreate = true;
}

// ---------- 输入区 ----------
export function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}
export function updateSendReady() {
  $("sendBtn").classList.toggle("ready", inputEl.value.trim().length > 0 || S.pendingFiles.length > 0);
}

// 分叉回填：文本进输入框，底座 ImageContent[] 转成本地附件 chip。
// ImageContent 字段形态（pi-ai types）：{ type:"image", data, mimeType }，兼容嵌套 source 形态
export function setComposerValue(text, images = []) {
  inputEl.value = text ?? "";
  for (const img of images ?? []) {
    const src = img?.source?.type === "base64" ? img.source : img;
    if (!src?.data) continue;
    S.pendingFiles.push({
      id: ++S.fileSeq,
      name: img.name || `图片${S.pendingFiles.length + 1}`,
      kind: "image",
      mime: src.mimeType || src.mediaType || "image/png",
      data: src.data,
    });
  }
  renderAttachRow();
  resizeInput();
  updateSendReady();
}

// ---------- 权限模式（omp 三值：always-ask | write | yolo） ----------
const MODE_META = {
  "always-ask": { label: "手动批准", icon: "permAsk", yolo: false },
  write: { label: "默认", icon: "permDefault", yolo: false },
  yolo: { label: "全自动", icon: "shieldWarn", yolo: true },
};
export function setApprovalModeUi(mode) {
  S.approvalMode = mode ?? "always-ask";
  const meta = MODE_META[S.approvalMode] ?? MODE_META["always-ask"];
  $("modeLabel").textContent = meta.label;
  // 按钮上的图标同步为当前模式图标（hydrateIcons 后占位 span 已替换为带 id 的 svg）
  const ic = $("modeIcon");
  if (ic) {
    const t = document.createElement("template");
    t.innerHTML = icon(meta.icon).trim();
    const svg = t.content.firstElementChild;
    if (svg) {
      svg.id = "modeIcon";
      ic.replaceWith(svg);
    }
  }
  modeBtn.classList.toggle("yolo", meta.yolo);
  modeBtn.classList.toggle("highlight-mode", meta.yolo);
  for (const mi of $("modeMenu").querySelectorAll(".mi[data-mode]")) {
    mi.querySelector(".ck").textContent = mi.dataset.mode === S.approvalMode ? "✓" : "";
  }
}

// ---------- 模型 / 思考级别（值域来自宿主下发） ----------
export const modelNames = new Map(); // "provider/id" -> 显示名
export const modelEfforts = new Map(); // "provider/id" -> 支持的思考档位（档位文字直接用英文原版 low/medium/…）

export function currentThinkingLevels() {
  const cur = activeOpen();
  const modelId = cur?.model || S.newSessionModel;
  const efforts = modelId ? modelEfforts.get(modelId) ?? [] : [];
  return efforts.length > 0 ? ["auto", "off", ...efforts] : ["off"];
}

// 模型选中（二级浮层与 #modelMenu 委托共用）：有会话走宿主下发，新建态落 localStorage
function pickModel(id) {
  const s = activeOpen();
  if (s) {
    send({ type: "set_model", sessionId: s.sessionId, model: id });
  } else {
    S.newSessionModel = id;
    S.newSessionDirty = true; // 手选后：后续 models 帧不再用配置默认覆盖
    try { localStorage.setItem("omp-new-model", id); } catch {}
    const validLevels = getSupportedThinkingForModel(id);
    if (!validLevels.includes(S.newSessionThinking)) {
      S.newSessionThinking = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
      try { localStorage.setItem("omp-new-thinking", S.newSessionThinking); } catch {}
    }
    renderComposerBar();
  }
  closeAllMenus();
}

// 模型二级菜单：一级列供应商（› 指示），悬停/点击向右弹出该供应商的模型浮层。
// 浮层挂在 #composer 上而非 #modelMenu 内——.menu.model 带 overflow-y:auto，
// 绝对定位子元素会被裁掉（点击穿透的坑）；#composer 是 offsetParent 且无裁切。
// 浮层带 .menu.open 类，window 级 closeAllMenus 会统一摘 .open 收起。
export function buildModelMenu() {
  const menu = $("modelMenu");
  menu.innerHTML = "";
  // 清理上次残留的浮层（closeAllMenus 只摘 .open 不删节点）
  composerEl.querySelectorAll(":scope > .menu.flyout").forEach((f) => f.remove());
  if (!modelNames || modelNames.size === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "mi empty";
    emptyEl.style.color = "var(--dim)";
    emptyEl.style.cursor = "default";
    emptyEl.style.justifyContent = "center";
    emptyEl.style.padding = "8px 12px";
    emptyEl.textContent = "未配置可用模型";
    menu.appendChild(emptyEl);
    return;
  }
  // 按 provider 分组（宿主下发 id 形如 "provider/modelId"）
  const groups = new Map();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov).push([id, name]);
  }
  const curModel = activeOpen()?.model || S.newSessionModel;
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
  for (const [prov, models] of groups) {
    const row = document.createElement("div");
    row.className = "mi prov";
    row.appendChild(document.createTextNode(prov));
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.innerHTML = icon("chevronRight", 10);
    row.appendChild(sub);
    const openFlyout = () => {
      cancelHide();
      closeFlyout();
      row.classList.add("on");
      flyout = document.createElement("div");
      flyout.className = "menu flyout open";
      for (const [id, name] of models) {
        const mi = document.createElement("div");
        mi.className = "mi";
        mi.dataset.model = id;
        const ck = document.createElement("span");
        ck.className = "ck";
        ck.textContent = curModel === id ? "✓" : "";
        mi.appendChild(ck);
        mi.appendChild(document.createTextNode(name));
        flyout.appendChild(mi);
      }
      composerEl.appendChild(flyout);
      // 坐标均为 #composer 相对（offsetParent），与 openComposerMenu 同一坐标系。
      // 顶部对齐供应商行（两菜单 padding 均 5px，-5 让首行与行高对齐），菜单滚动时扣除 scrollTop。
      // 注意不得钳位到 0：菜单一 carousel 般向上超出 composer 时 offsetTop 为负，
      // 浮层必须跟着行走到 composer 上方（无 overflow 裁切），钳位会让浮层整体下滑错位
      flyout.style.top = menu.offsetTop + row.offsetTop - menu.scrollTop - 5 + "px";
      const left = menu.offsetLeft + menu.offsetWidth - 4; // 与一级菜单边框交叠 4px，视觉无缝
      flyout.style.left = left + "px";
      // 右缘越界时翻到左侧弹出
      if (flyout.getBoundingClientRect().right > window.innerWidth - 8) {
        flyout.style.left = Math.max(0, menu.offsetLeft - flyout.offsetWidth + 4) + "px";
      }
      flyout.addEventListener("mouseenter", () => { cancelHide(); clearTimeout(switchTimer); });
      flyout.addEventListener("mouseleave", armHide);
      flyout.addEventListener("click", (e) => {
        const mi = e.target.closest(".mi[data-model]");
        if (mi) pickModel(mi.dataset.model);
      });
    };
    // 行切换加 180ms 悬停意图延时：指针斜向穿过中间行去够浮层时不抢焦（浮层
    // mouseenter 会取消待切换），停够才换供应商；点击仍即时展开/收起
    row.addEventListener("mouseenter", () => {
      cancelHide();
      if (row.classList.contains("on")) return;
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => { closeFlyout(); openFlyout(); }, 180);
    });
    row.addEventListener("mouseleave", () => clearTimeout(switchTimer));
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.classList.contains("on")) closeFlyout();
      else openFlyout();
    });
    menu.appendChild(row);
  }
}

export function buildThinkMenu() {
  const menu = $("thinkMenu");
  menu.innerHTML = '<div class="mh">推理强度</div>';
  const curThinking = activeOpen()?.thinking || S.newSessionThinking;
  for (const lv of currentThinkingLevels()) {
    const mi = document.createElement("div");
    mi.className = "mi";
    mi.dataset.level = lv;
    const ck = document.createElement("span");
    ck.className = "ck";
    ck.textContent = curThinking === lv ? "✓" : "";
    mi.appendChild(ck);
    mi.appendChild(document.createTextNode(lv));
    menu.appendChild(mi);
  }
}

export function ingestModels(models) {
  modelNames.clear();
  modelEfforts.clear();
  for (const m of models ?? []) {
    modelNames.set(m.id, m.name);
    modelEfforts.set(m.id, m.efforts ?? []);
  }
}

// 打开 composer 内菜单：锚定按钮（left 跟随、底部贴按钮上方 8px 向上展开），右缘不越界。
// 垂直方向按按钮实时 offsetTop 计算而非固定 bottom:44px——后者只在单行布局侥幸成立，
// 换行/分级收缩导致按钮位移后弹窗会脱离按钮（新建会话窄窗口错位 bug 的根因）。
// 输入框本身只有 ~100px 高，菜单普遍比它高：老式 max(4,…) 钳位会把菜单压到输入框
// 顶部，盖住输入区并向下溢出（权限/模型/思考三弹窗错位的根因）；上方视口空间不足时
// 改限高 + 内部滚动，菜单顶最多到视口上沿 4px，底缘仍贴按钮上方
export function openComposerMenu(menu, btn) {
  closeAllMenus();
  document.querySelectorAll(".pill-btn.active").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  menu.classList.add("open");
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const z = S.zoomLevel || 1;
  const maxLeft = composerEl.clientWidth - menu.offsetWidth - 4;
  menu.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLeft)) + "px";
  const btnAbsTop = btn.getBoundingClientRect().top;
  let top = btn.offsetTop - menu.offsetHeight - 8;
  if (btnAbsTop - (menu.offsetHeight + 8) * z < 4) {
    const compTop = composerEl.getBoundingClientRect().top;
    menu.style.maxHeight = Math.max(80, Math.round((btnAbsTop - 8 * z - 4) / z)) + "px";
    menu.style.overflowY = "auto";
    top = Math.round((4 - compTop) / z);
  }
  menu.style.top = top + "px";
  menu.style.bottom = "auto";
}

// ---------- 排队消息卡（输入框上方的重叠卡）：流式中发送的消息在此排队，
// 当前 loop 完全处理后自动消费第 1 条；每条可立即发送（转 steer）/编辑（回输入框）/删除 ----------
export function renderQueueLine() {
  const el = $("queueCard");
  if (!el) return;
  const s = activeOpen();
  const items = s?.queued ?? [];
  el.innerHTML = "";
  items.forEach((m) => {
    const item = { role: "user", text: m.text || "", pending: "queued" }; // 与气泡动作共用的伪 item
    const row = document.createElement("div");
    row.className = "qc-row";
    row.title = "排队中：当前任务完成后自动发送";
    const dots = document.createElement("span");
    dots.className = "qc-dots";
    dots.innerHTML = icon("dots", 13);
    const tx = document.createElement("span");
    tx.className = "qc-tx";
    tx.textContent = m.text || "（无文本）";
    const mk = (title, ic, fn) => {
      const b = document.createElement("button");
      b.className = "q-btn";
      b.title = title;
      b.innerHTML = icon(ic, 13);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    row.append(
      dots,
      tx,
      mk("立即发送（当前步骤后注入）", "upload", () => sendNowQueueMsg(s, item)),
      mk("编辑（放回输入框）", "pencil", () => editQueueMsg(s, item)),
      mk("删除", "trash", () => dropQueueMsg(s, item)),
    );
    el.appendChild(row);
  });
  el.hidden = items.length === 0;
}

// ---------- composer 状态条（模式/模型/思考 按钮文案与禁用态 + 上下文环） ----------
const RING_C = 40.84; // 2π×6.5（与 CSS dasharray 一致）

// 停止生成按钮（initComposer 时动态创建，插在发送钮左侧）：仅流式期间显示。
// 发送钮在流式中仍是「排队发送」，两者并存互不冲突
let stopBtn = null;

export function renderComposerBar() {
  const s = activeOpen();
  // 停止钮随流式状态显隐；turn_end 重绘（streaming=false）时隐藏并复位防连点禁用态
  if (stopBtn) {
    const streaming = !!s?.streaming;
    stopBtn.hidden = !streaming;
    if (!streaming) stopBtn.disabled = false;
  }
  if (!s && S.isCreatingNew) {
    modelBtn.disabled = thinkBtn.disabled = false;
    const mName = modelNames.get(S.newSessionModel) ?? (S.newSessionModel ? S.newSessionModel.split("/").pop() : "模型");
    $("modelLabel").textContent = mName;
    $("thinkLabel").textContent = S.newSessionThinking || "思考";
    // 上下文环无会话时也展示为空环:hover 弹出配额(见 ctxRing mouseenter)
    $("ctxRing").hidden = false;
    $("ctxRingFill").style.strokeDashoffset = String(RING_C);
    $("ctxRing").className = "ctx-ring";
    updateBgTaskButton();
    updateBgSubagentButton();
    fitComposerBar();
    return;
  }
  modelBtn.disabled = thinkBtn.disabled = !s;
  $("modelLabel").textContent = s?.model ? (modelNames.get(s.model) ?? s.model.split("/").pop()) : "模型";
  $("modelIcon").textContent = PROV_IC[s?.model?.split("/")[0]] || "✦";
  // auto 会话且有本轮判定结果时显示 "auto·档位"（thinking_level 事件写入 s.autoResolved）；
  // 无判定（刚切进 auto/新会话未发言）或手动档位维持原样
  $("thinkLabel").textContent = s
    ? (s.thinking === "auto" && s.autoResolved ? `auto·${s.autoResolved}` : (s.thinking || "思考"))
    : "思考";
  // 上下文环：从顶端顺时针填充；无数据空环
  const ring = $("ctxRing");
  ring.hidden = !s;
  if (s) {
    const p = s.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
    $("ctxRingFill").style.strokeDashoffset = String(RING_C * (1 - p));
    ring.className = "ctx-ring" + (s.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
  }
  updateBgTaskButton();
  updateBgSubagentButton();
  fitComposerBar();
}

// 底栏分级收缩：布局宽度不足时按固定顺序逐级收缩——
// 1 权限模式→纯图标 → 2 思考级别→纯图标 → 3 模型→纯图标 → 4 隐藏子智能体 → 5 隐藏后台任务。
// 用布局宽度判定（scrollWidth > clientWidth 即溢出），界面缩放(zoom)下两端同比例换算，依然准确；
// 全部收完仍不够就不再处理，由 #composer min-width 托底
const BAR_STAGES = 5;
let barStage = 0;
export function fitComposerBar() {
  if (!composerEl) return;
  composerEl.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5");
  const cbar = composerEl.querySelector(".cbar");
  let stage = 0;
  if (cbar) {
    // 需求宽度 = 各可见子项 offsetWidth 之和 + 间隙（flex 子项不压缩、.sp 弹性间隔除外）。
    // 不用 scrollWidth：overflow:hidden 的 flex 容器在 Chrome/WebKit 下对 flex:none
    // 子项的 scrollWidth 返回值不可靠（实测被钳到 clientWidth）
    const gap = parseFloat(getComputedStyle(cbar).columnGap) || 6;
    const needWidth = () => {
      const vis = [...cbar.children].filter((k) => !k.classList.contains("sp") && k.offsetWidth > 0);
      return vis.reduce((a, k) => a + k.offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
    };
    while (stage < BAR_STAGES && needWidth() > cbar.clientWidth) {
      stage++;
      composerEl.classList.add("bar-" + stage);
    }
  }
  if (stage !== barStage) {
    barStage = stage;
    // 阶段变化会移动按钮，打开中的菜单锚点随之失效，直接收起
    if (composerEl.querySelector(".menu.open")) closeAllMenus();
  }
}

export function initComposer() {
  // 停止生成按钮：cbar 内发送钮左侧（流式时发送钮语义是「排队」，停止钮独立一旁）
  stopBtn = document.createElement("button");
  stopBtn.className = "send stop-btn";
  stopBtn.title = "停止生成";
  stopBtn.hidden = true;
  stopBtn.innerHTML = icon("stop");
  stopBtn.addEventListener("click", () => {
    const s = activeOpen();
    if (!s?.streaming || stopBtn.disabled) return;
    stopBtn.disabled = true; // 防连点：turn_end 重绘时复位（renderComposerBar）
    send({ type: "abort_session", sessionId: s.sessionId });
  });
  $("sendBtn").before(stopBtn);

  $("plusBtn").addEventListener("click", () => $("filePicker").click());
  $("filePicker").addEventListener("change", async (e) => {
    const picked = [...e.target.files];
    e.target.value = ""; // 允许重复选同一文件
    for (const file of picked) {
      if (file.size > MAX_ATTACH_BYTES) {
        toast(`「${file.name}」超过 10MB，未添加`);
        continue;
      }
      try {
        if (file.type.startsWith("image/")) {
          const dataUrl = await new Promise((ok, no) => {
            const r = new FileReader();
            r.onload = () => ok(r.result);
            r.onerror = () => no(r.error);
            r.readAsDataURL(file);
          });
          S.pendingFiles.push({ id: ++S.fileSeq, name: file.name, kind: "image", mime: file.type, data: dataUrl.split(",")[1] });
        } else {
          S.pendingFiles.push({ id: ++S.fileSeq, name: file.name, kind: "text", mime: file.type || "text/plain", data: await file.text() });
        }
      } catch {
        toast(`读取「${file.name}」失败`);
      }
    }
    renderAttachRow();
    updateSendReady();
  });

  inputEl.addEventListener("input", () => {
    resizeInput();
    updateSendReady();
  });
  $("sendBtn").addEventListener("click", sendPrompt);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (typeof settingsOpen === "function" && settingsOpen()) return;
      e.preventDefault();
      sendPrompt();
    }
  });

  $("modeMenu").addEventListener("click", (e) => {
    const mi = e.target.closest(".mi[data-mode]");
    if (!mi) return;
    const mode = mi.dataset.mode;
    const s = activeOpen();
    if (s) {
      send({ type: "set_approval_mode", sessionId: s.sessionId, mode });
    } else {
      send({ type: "set_approval_mode", mode });
    }
    setApprovalModeUi(mode);
    closeAllMenus();
  });

  // 一级供应商行点击不冒泡给 pickModel（无 data-model），模型项在二级浮层内自处理
  $("modelMenu").addEventListener("click", (e) => {
    const mi = e.target.closest(".mi[data-model]");
    if (mi) pickModel(mi.dataset.model);
  });

  $("thinkMenu").addEventListener("click", (e) => {
    const mi = e.target.closest(".mi[data-level]");
    if (!mi) return;
    const lv = mi.dataset.level;
    const s = activeOpen();
    if (s) {
      send({ type: "set_thinking", sessionId: s.sessionId, level: lv });
    } else {
      S.newSessionThinking = lv;
      S.newSessionDirty = true; // 手选后：后续 models 帧不再用配置默认覆盖
      try { localStorage.setItem("omp-new-thinking", lv); } catch {}
      renderComposerBar();
    }
    closeAllMenus();
  });

  modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("modeMenu");
    if (menu.classList.contains("open")) return closeAllMenus();
    openComposerMenu(menu, modeBtn);
  });
  modelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeOpen() && !S.isCreatingNew) return;
    const menu = $("modelMenu");
    if (menu.classList.contains("open")) return closeAllMenus();
    buildModelMenu();
    openComposerMenu(menu, modelBtn);
  });
  thinkBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeOpen() && !S.isCreatingNew) return;
    const menu = $("thinkMenu");
    if (menu.classList.contains("open")) return closeAllMenus();
    buildThinkMenu();
    openComposerMenu(menu, thinkBtn);
  });

  // 窗口/分栏/缩放引起 composer 宽度变化时重新适配
  new ResizeObserver(() => fitComposerBar()).observe(composerEl);
}
