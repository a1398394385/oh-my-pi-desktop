// 输入区：附件行 + textarea + cbar（添加/权限模式/后台任务/子智能体/上下文环/模型/思考/
// 发送）+ 三个弹出菜单 + 排队卡。迁移自 ui/composer.js（578 行）。
// 契约：输入草稿用非受控 textarea + 模块级 draft 变量（等价原 inputEl.value，
// 欢迎页 ↔ dock 两个挂载位切换不丢值）；S.composerSetSignal（seq 信号）effect 回填（含图片）；
// 发送/停止合一（流式且无草稿 → 停止）；模型/思考菜单读 store 的 modelNames/modelEfforts。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { S, useStore, notify, activeOpen, send, toast, modelNames } from "../store.js";
import Icon from "../Icon.jsx";
import AttachRow from "./composer/AttachRow.jsx";
import QueueCard from "./composer/QueueCard.jsx";
import ModeMenu, { MODE_META } from "./composer/ModeMenu.jsx";
import ModelMenu from "./composer/ModelMenu.jsx";
import ThinkMenu from "./composer/ThinkMenu.jsx";

// 模块级输入草稿（跨挂载位保留，等价原 inputEl.value）
const draft = { value: "" };

// 待发送附件上限：图片走 ImageContent（base64），文本类文件内联进 prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// 供应商符号（复制自 ui/settings/index.js PROV_IC；该模块顶层有设置页绑定副作用，不宜引入）
const PROV_IC = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// 上下文环周长：2π×6.5（与 CSS dasharray 一致）
const RING_C = 40.84;

// 底栏分级收缩的最大级数（权限模式/思考/模型→纯图标、隐藏子智能体、隐藏后台任务）
const BAR_STAGES = 5;

// textarea 自适应高度（原 resizeInput 平移）：上限 120px
function resizeInput(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}

// 组装随 prompt 下发的附件载荷（发送后由调用方清空 pendingFiles）
function buildAttachPayload() {
  return S.pendingFiles.map((f) =>
    f.kind === "image"
      ? { kind: "image", mime: f.mime, data: f.data }
      : { kind: "text", name: f.name, text: f.data }
  );
}

// 后台命令运行计数（原 right.js getBgTasksForSession 的 runningCount 部分平移：
// 只遍历 s.items 顶层——封进 loop 组的工具不再计；hub start 计入、stop/cancel 抵消同名进程）
function bgTaskCount(s) {
  if (!s) return 0;
  let n = 0;
  const live = new Set();
  for (const it of s.items) {
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const proc = args.name || args.application || "";
      if (op === "start") {
        n++;
        if (proc) live.add(proc);
      } else if ((op === "stop" || op === "cancel") && proc && live.has(proc)) {
        n--;
        live.delete(proc);
      } else if (it.running) {
        n++;
      }
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      n++;
    }
  }
  return Math.max(0, n);
}

// 运行中子智能体计数（原 right.js getRunningSubagentCount 平移）
function subagentCount(s) {
  if (!s?.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}

export default function Composer({ inWelcome }) {
  useStore();
  const s = activeOpen();
  const rootRef = useRef(null); // #composer
  const taRef = useRef(null); // textarea
  const cbarRef = useRef(null);
  const pickerRef = useRef(null); // filePicker
  const modeBtnRef = useRef(null);
  const modelBtnRef = useRef(null);
  const thinkBtnRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null); // "mode" | "model" | "think" | null（互斥）
  const [stopPending, setStopPending] = useState(false); // 停止钮防连点（turn_end 复位）
  const barStageRef = useRef(0); // 上次收缩级数（变化时收起打开中的菜单）

  const text = draft.value;
  const hasDraft = text.trim().length > 0 || S.pendingFiles.length > 0;
  const stopping = !!s?.streaming && !hasDraft;

  // ---- 外部回填信号（分叉 selectedText / 排队消息编辑），对齐原 setComposerValue（含图片） ----
  useEffect(() => {
    const sig = S.composerSetSignal;
    if (!sig || !taRef.current) return;
    taRef.current.value = sig.text;
    draft.value = sig.text;
    // 底座 ImageContent[] 转本地附件 chip：字段形态 { type:"image", data, mimeType }，兼容嵌套 source 形态
    for (const img of sig.images ?? []) {
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
    S.composerSetSignal = null;
    resizeInput(taRef.current);
    notify(); // 附件 push 后重渲附件行
    taRef.current.focus();
  });

  // ---- 挂载位切换（欢迎页 ↔ dock 实例重建）：恢复草稿高度；欢迎页聚焦（原 50ms focus） ----
  useLayoutEffect(() => {
    resizeInput(taRef.current);
    if (inWelcome) taRef.current?.focus();
  }, [inWelcome]);

  // ---- 发送链路（原 sendPrompt 平移） ----
  const clearDraft = () => {
    draft.value = "";
    if (taRef.current) {
      taRef.current.value = "";
      resizeInput(taRef.current);
    }
    S.pendingFiles = [];
    notify();
  };
  const sendPrompt = () => {
    const t = draft.value.trim();
    const files = buildAttachPayload();
    if ((!t && files.length === 0) || !S.ws || S.ws.readyState !== 1) return;

    // 新建态：草稿存 pendingNewPrompt，session_created 回执后由 store 代发
    if (S.isCreatingNew || !s) {
      S.pendingNewPrompt = { text: t, files };
      clearDraft();
      send({
        type: "create_session",
        cwd: S.newSessionProject || undefined,
        model: S.newSessionModel || undefined,
        thinking: S.newSessionThinking || undefined,
      });
      S.pendingCreate = true;
      return;
    }
    // 流式中发送 = 排队（followUp，当前 loop 完自动消费）：只进队列卡，不出气泡、
    // 不截断过程——「立即发送」转 steer 也只是先出气泡，分割发生在消费时刻（steer_consumed）
    if (s.streaming) {
      s.queued = s.queued ?? [];
      s.queued.push({ text: t });
    } else {
      s.items.push({ role: "user", text: t });
    }
    clearDraft();
    S.ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text: t, files }));
    // 钉底跟随由 Chat 组件的滚动 effect 处理
  };

  // ---- 输入 ----
  const onInput = (e) => {
    draft.value = e.target.value;
    resizeInput(e.target);
    notify(); // 刷新发送钮 ready 态
  };

  // ---- 附件选择（原 filePicker change 平移） ----
  const onPick = async (e) => {
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
    notify();
  };

  // ---- 停止钮防连点复位（原 turn_end 重绘时复位 disabled） ----
  useEffect(() => {
    if (!stopping) setStopPending(false);
  }, [stopping]);

  // ---- 点外部 / 窗口失焦关菜单（原 window click/blur → closeAllMenus） ----
  useEffect(() => {
    const close = () => setOpenMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  // ---- 底栏分级收缩（原 fitComposerBar 平移；bar-N 类为命令式追加，className prop 恒定 React 不会覆盖） ----
  const fit = () => {
    const comp = rootRef.current;
    const cbar = cbarRef.current;
    if (!comp) return;
    comp.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5");
    let stage = 0;
    if (cbar) {
      // 需求宽度 = 各可见子项 offsetWidth 之和 + 间隙（不用 scrollWidth：overflow:hidden 的
      // flex 容器在 WebKit 下对 flex:none 子项的 scrollWidth 被钳到 clientWidth，不可靠）
      const gap = parseFloat(window.getComputedStyle(cbar).columnGap) || 6;
      const needWidth = () => {
        const vis = [...cbar.children].filter((k) => !k.classList.contains("sp") && k.offsetWidth > 0);
        return vis.reduce((a, k) => a + k.offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
      };
      while (stage < BAR_STAGES && needWidth() > cbar.clientWidth) {
        stage++;
        comp.classList.add("bar-" + stage);
      }
    }
    if (stage !== barStageRef.current) {
      barStageRef.current = stage;
      // 阶段变化会移动按钮，打开中的菜单锚点随之失效，直接收起
      if (comp.querySelector(".menu.open")) setOpenMenu(null);
    }
  };
  useLayoutEffect(fit);
  // 窗口/分栏/缩放引起 composer 宽度变化时重新适配
  useEffect(() => {
    const comp = rootRef.current;
    if (!comp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(comp);
    return () => ro.disconnect();
  }, []);

  // ---- cbar 各按钮态 ----
  const modeMeta = MODE_META[S.approvalMode] ?? MODE_META["always-ask"];
  const menuDisabled = !(s || S.isCreatingNew); // 无会话且非新建态：模型/思考不可用
  const modelName = S.isCreatingNew || !s
    ? (S.newSessionModel ? (modelShort(S.newSessionModel) || "模型") : "模型")
    : modelShort(s.model) || "模型";
  const thinkLabel = s
    ? (s.thinking === "auto" && s.autoResolved ? `auto·${s.autoResolved}` : s.thinking || "思考")
    : S.newSessionThinking || "思考";
  const bgTasks = bgTaskCount(s);
  const bgSubs = subagentCount(s);

  // 菜单按钮通用开关：再点同钮收起，互斥由单 state 天然保证
  const toggleMenu = (name) => (e) => {
    e.stopPropagation(); // 不冒泡给 window 级关闭监听
    setOpenMenu(openMenu === name ? null : name);
  };

  // 后台任务/子智能体按钮：展开并切换右栏对应 tab，再点收起右栏（原 right.js 绑定平移）
  const toggleBgTab = (tab) => () => {
    if (!s) return;
    if (!S.rightCollapsed && S.rightTab === tab) {
      S.rightCollapsed = true;
    } else {
      S.rightTab = tab;
      S.selectedFile = null;
      S.selectedSubagent = null;
      S.rightCollapsed = false;
    }
    notify();
  };

  return (
    <>
      {/* 排队卡与输入区拼成一张重叠卡（仿新建会话页背卡），仅 dock 挂载位渲染 */}
      {!inWelcome && <QueueCard />}
      <div id="composer" className={inWelcome ? "in-welcome" : ""} ref={rootRef}>
        <AttachRow />
        <textarea
          id="input"
          rows="1"
          ref={taRef}
          defaultValue={draft.value}
          placeholder={inWelcome ? "使用 @ 添加上下文，使用 / 选择命令或能力" : "发消息…（Enter 发送）"}
          onInput={onInput}
          onKeyDown={(e) => {
            // isComposing：中文输入法选字中的回车不发送
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              sendPrompt();
            }
          }}
        ></textarea>
        <div className="cbar" ref={cbarRef}>
          <button className="icon-btn plus-btn" id="plusBtn" title="添加上下文" onClick={() => pickerRef.current?.click()}>
            <Icon name="plus" />
          </button>
          <button
            className={"pill-btn" + (openMenu === "mode" ? " active" : "") + (modeMeta.yolo ? " yolo highlight-mode" : "")}
            id="modeBtn"
            title="权限模式"
            ref={modeBtnRef}
            onClick={toggleMenu("mode")}
          >
            <Icon name={modeMeta.icon} id="modeIcon" />
            <span id="modeLabel">{modeMeta.label}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"pill-btn bg-task-btn" + (bgTasks > 0 ? " has-running" : "") + (!S.rightCollapsed && S.rightTab === "bgcmd" ? " on" : "")}
            id="bgTaskBtn"
            title="后台命令"
            disabled={!s}
            onClick={toggleBgTab("bgcmd")}
          >
            <Icon name="termBox" size={18} />
            <span className="bg-task-num" id="bgTaskNum">{s ? bgTasks : 0}</span>
          </button>
          <button
            className={"pill-btn bg-task-btn" + (bgSubs > 0 ? " has-running" : "") + (!S.rightCollapsed && S.rightTab === "subagent" ? " on" : "")}
            id="bgSubagentBtn"
            title="子智能体"
            disabled={!s}
            onClick={toggleBgTab("subagent")}
          >
            <Icon name="agents" size={18} />
            <span className="bg-task-num" id="bgSubagentNum">{s ? bgSubs : 0}</span>
          </button>
          <span className="sp"></span>
          <CtxRing s={s} />
          <button
            className={"pill-btn" + (openMenu === "model" ? " active" : "")}
            id="modelBtn"
            title="切换模型"
            ref={modelBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("model")}
          >
            <span id="modelIcon">{s?.model ? PROV_IC[s.model.split("/")[0]] || "✦" : "✦"}</span>
            <span id="modelLabel">{modelName}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"pill-btn" + (openMenu === "think" ? " active" : "")}
            id="thinkBtn"
            title="思考级别"
            ref={thinkBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("think")}
          >
            <Icon name="think" size={16} />
            <span id="thinkLabel">{thinkLabel}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"send" + (hasDraft ? " ready" : "") + (stopping ? " stopping" : "")}
            id="sendBtn"
            disabled={stopping && stopPending}
            title={stopping ? "停止生成" : s?.streaming ? "发送（排队，当前任务完成后发出）" : "发送"}
            onClick={() => {
              // 停止形态（流式中且输入框空）：中止生成；发送形态：照常发送/排队
              if (stopping) {
                if (stopPending) return;
                setStopPending(true); // 防连点：turn_end 后复位
                send({ type: "abort_session", sessionId: s.sessionId });
                return;
              }
              sendPrompt();
            }}
          >
            <Icon name={stopping ? "stop" : "upload"} />
          </button>
        </div>
        {/* 权限模式（omp 三值，大行样式） */}
        {openMenu === "mode" && <ModeMenu btnRef={modeBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        {/* 模型（宿主 enabledModels 过滤后下发，按 provider 分组；二级浮层为 #composer 直接子节点） */}
        {openMenu === "model" && <ModelMenu btnRef={modelBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        <input type="file" id="filePicker" multiple hidden ref={pickerRef} onChange={onPick} />
        {/* 思考级别（只列当前模型支持的档位） */}
        {openMenu === "think" && <ThinkMenu btnRef={thinkBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
      </div>
    </>
  );
}

// 上下文环（原 renderComposerBar 的 ctxRing 段平移）：从顶端顺时针填充；无数据空环；
// 新建态也展示空环。hover 弹配额卡归 ringpop-wave。
function CtxRing({ s }) {
  if (!s && !S.isCreatingNew) return null;
  const p = s?.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
  const cls = "ctx-ring" + (s?.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
  return (
    <span className={cls} id="ctxRing" title="">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <circle className="track" cx="8" cy="8" r="6.5" />
        <circle
          className="fill"
          id="ctxRingFill"
          cx="8"
          cy="8"
          r="6.5"
          transform="rotate(-90 8 8)"
          style={{ strokeDashoffset: String(RING_C * (1 - p)) }}
        />
      </svg>
    </span>
  );
}

// 模型显示名：modelNames 查表，无表项时取 id 尾段（原 renderComposerBar 同款）
function modelShort(id) {
  if (!id) return "";
  return modelNames.get(id) ?? id.split("/").pop();
}
