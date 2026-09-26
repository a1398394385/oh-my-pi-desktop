// UI slice：壳折叠/缩放、新建会话页（newSession*）、输入框草稿与 sigil 补全态、
// toast/composer 信号、动画开关、ringpop 瞬态、UI 偏好（localStorage 合并）。
// 自 store.ts 平移（P3 波 2）；变更一律 setState 换值/换引用（订阅自动感知），
// 静默写（draftHasContent 等，旧版不 notify）只 set 不 bump。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { UiPrefs } from "./shapes";
import type { ContextDetailFrame, LimitsResultFrame, FileMatch, PromptAttachment, SlashCommand } from "../types/frames";
import { activeOpen, getSupportedThinkingForModel } from "./session";

/** setTimeout 句柄(DOM 与 Node 环境返回类型不同,统一别名;TS 环境含 Node 类型时返回 Timeout) */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface UiSlice {
  zoomLevel: number;
  sidebarCollapsed: boolean;
  rightCollapsed: boolean;
  isCreatingNew: boolean;
  newSessionProject: string;
  newSessionBranch: string;
  newSessionBranches: string[]; // git_branches 帧 branches 落地(新建会话页分支选择;分支名清单)
  newSessionIsGit: boolean;
  newSessionModel: string;
  newSessionThinking: string;
  defaultModelCfg: string | null; // models 帧 defaultModel 落地
  defaultThinkingCfg: string | null; // models 帧 defaultThinking 落地
  newSessionDirty: boolean;
  pendingFiles: (PromptAttachment & { id: number })[]; // 输入框附件 chip(带前端本地 id,发送时剥离)
  fileSeq: number;
  animateGdKids: boolean;
  animateThinkBody: boolean;
  animateSubKids?: boolean; // 子代理详情入场动画标记(运行时挂上,SubagentPage 专用)
  toastMsg: string | null; // 当前 toast 文本（null = 隐藏）
  composerSetSignal: { text: string; images: unknown[] | null; seq: number } | null; // 外部填输入框的信号（分叉回填 / 排队消息编辑）
  findOpen: boolean; // 会话内查找栏开合（FindBar 同步;Esc 中断生成前的守卫）
  menuSignal: { name: string; seq: number } | null; // 外部打开 composer 菜单的信号（快捷键 Alt+M）
  draftHasContent: boolean; // 输入框是否有草稿（Composer 每次渲染同步,Esc 二次确认用）
  escArmedUntil: number; // Esc 二次确认窗口的截止时刻（> 现在 = 发送钮显示取消图标）
  commands: SlashCommand[] | null; // 当前会话斜杠命令清单（null = 未拉取，弹层显示加载中）
  commandsSessionId: string | null; // 清单归属会话 id，切会话即失效
  mentionReqSeq: number; // list_files 请求序号（reqId 生成器，前端自增）
  mentionResult: { reqId: number; matches: FileMatch[] } | null; // 最新 @ 候选响应；reqId 与当前请求不匹配即过期
  ctxDetail: ContextDetailFrame | null; // 最近一次 context_detail 回包（ringpop 弹卡瞬态,移开即弃）
  ctxLimits: LimitsResultFrame | null; // 最近一次 limits_result 回包
  uiPrefs: UiPrefs;
  toast(msg: unknown): void;
  setComposerValue(text: string, images?: unknown[] | null): void;
  showWelcomeScreen(preferredCwd?: string | null): void;
  hideWelcomeScreen(): void;
  setWelcomeProject(cwd?: string): void;
  initNewSessionModel(force?: boolean): void;
  pickModelId(id: string): void;
  pickThinkingLevel(lv: string): void;
}

const uiPrefsInit: UiPrefs = {
  uiFont: "default",
  uiFontSize: 13,
  codeFontSize: 12,
  lineNumbers: true,
  codeWrap: false,
  showThinking: true,
  expandToolOutput: true,
  lang: "zh-CN",
  terminalInheritProfile: true,
  terminalFont: "",
};
try {
  Object.assign(uiPrefsInit, JSON.parse(localStorage.getItem("omp-ui-settings") || "{}"));
} catch {}

// toast：App 层 Toast 组件消费 toastMsg（2.2s 自动隐藏）
let toastTimer: TimerHandle | undefined;
// 外部填输入框（分叉回填 / 排队消息编辑）：Composer 组件 effect 监听 seq
let composerSetSeq = 0;

export const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set, get) => ({
  zoomLevel: 1,
  sidebarCollapsed: localStorage.getItem("omp-sidebar-collapsed") === "1",
  // 右栏默认折叠（对齐旧版 index.html <aside id="right" class="collapsed">）；手动展开过后按 localStorage 记忆
  rightCollapsed: localStorage.getItem("omp-right-collapsed") === null ? true : localStorage.getItem("omp-right-collapsed") === "1",
  isCreatingNew: false,
  newSessionProject: "",
  newSessionBranch: "",
  newSessionBranches: [],
  newSessionIsGit: false,
  newSessionModel: "",
  newSessionThinking: "auto",
  defaultModelCfg: null,
  defaultThinkingCfg: null,
  newSessionDirty: false,
  pendingFiles: [],
  fileSeq: 0,
  animateGdKids: false,
  animateThinkBody: false,
  toastMsg: null,
  composerSetSignal: null,
  findOpen: false,
  menuSignal: null,
  draftHasContent: false,
  escArmedUntil: 0,
  commands: null,
  commandsSessionId: null,
  mentionReqSeq: 0,
  mentionResult: null,
  ctxDetail: null,
  ctxLimits: null,
  uiPrefs: uiPrefsInit,

  toast(msg) {
    set((s) => ({ toastMsg: String(msg) }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      set((s) => ({ toastMsg: null }));
    }, 2200);
  },

  setComposerValue(text, images = []) {
    set((s) => ({ composerSetSignal: { text, images, seq: ++composerSetSeq } }));
  },

  showWelcomeScreen(preferredCwd) {
    const alreadyOpen = get().isCreatingNew;
    set((s) => ({ isCreatingNew: true, activePath: null }));
    if (!alreadyOpen) {
      get().send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
      set({ newSessionDirty: false });
      get().initNewSessionModel(true);
    }
    const st = get();
    const avail = st.getAvailableProjects();
    const stored = localStorage.getItem("omp-new-project");
    const targetProject =
      (preferredCwd && avail.some((p) => p.cwd === preferredCwd) ? preferredCwd : null) ||
      (st.newSessionProject && avail.some((p) => p.cwd === st.newSessionProject) ? st.newSessionProject : null) ||
      (stored && avail.some((p) => p.cwd === stored) ? stored : null) ||
      avail[0]?.cwd ||
      "/";
    if (!alreadyOpen || targetProject !== st.newSessionProject) get().setWelcomeProject(targetProject);
    get().initNewSessionModel();
  },

  hideWelcomeScreen() {
    set((s) => ({ isCreatingNew: false }));
  },

  setWelcomeProject(cwd) {
    if (!cwd) {
      const avail = get().getAvailableProjects();
      cwd = avail[0]?.cwd || "/";
    }
    try {
      localStorage.setItem("omp-new-project", cwd);
    } catch {}
    set((s) => ({
      newSessionProject: cwd,
      newSessionIsGit: false,
      newSessionBranch: "",
      newSessionBranches: [],
    }));
    get().send({ type: "get_git_branches", cwd });
    if (cwd) get().expandProject(cwd);
  },

  // force = 点新建/配置下发刷新：模型与档位回到配置文件默认；非 force 只做缺失兜底
  initNewSessionModel(force = false) {
    const st = get();
    const modelNames = st.modelNames;
    let newSessionModel = st.newSessionModel;
    if (force && st.defaultModelCfg && modelNames.has(st.defaultModelCfg)) {
      newSessionModel = st.defaultModelCfg;
    } else if (!newSessionModel || !modelNames.has(newSessionModel)) {
      const saved = localStorage.getItem("omp-new-model");
      if (saved && modelNames.has(saved)) {
        newSessionModel = saved;
      } else {
        const all = Array.from(modelNames.keys());
        const glm = all.find((id) => id.toLowerCase().includes("glm"));
        newSessionModel = glm || all[0] || "";
      }
    }
    const validLevels = getSupportedThinkingForModel(newSessionModel);
    let th =
      force && st.defaultThinkingCfg
        ? st.defaultThinkingCfg
        : st.newSessionThinking || localStorage.getItem("omp-new-thinking") || "auto";
    if (!validLevels.includes(th)) {
      th = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
    }
    set({ newSessionModel, newSessionThinking: th });
  },

  /** 模型选中（模型菜单与 Ctrl+P 循环共用）：有会话走宿主下发；新建态落盘，档位不合法时回落 */
  pickModelId(id) {
    const s = activeOpen();
    if (s) {
      get().send({ type: "set_model", sessionId: s.sessionId, model: id });
      return;
    }
    set((st) => ({ newSessionModel: id, newSessionDirty: true })); // 手选后：后续 models 帧不再用配置默认覆盖
    try {
      localStorage.setItem("omp-new-model", id);
    } catch {}
    const validLevels = getSupportedThinkingForModel(id);
    const cur = get().newSessionThinking;
    if (!validLevels.includes(cur)) {
      const fallback = validLevels.includes("auto") ? "auto" : validLevels[0] || "auto";
      set((st) => ({ newSessionThinking: fallback }));
      try {
        localStorage.setItem("omp-new-thinking", fallback);
      } catch {}
    }
  },

  /** 思考档位选中（思考菜单与 Shift+Tab 循环共用）：有会话走宿主下发，新建态落盘 */
  pickThinkingLevel(lv) {
    const s = activeOpen();
    if (s) {
      get().send({ type: "set_thinking", sessionId: s.sessionId, level: lv });
      return;
    }
    set((st) => ({ newSessionThinking: lv, newSessionDirty: true }));
    try {
      localStorage.setItem("omp-new-thinking", lv);
    } catch {}
  },
});
