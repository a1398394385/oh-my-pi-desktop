// UI slice: shell collapse/zoom, the new-session page (newSession*), composer draft and sigil
// completion state, toast/composer signals, animation toggles, ringpop transients, UI prefs
// (merged from localStorage).
// Moved over from store.ts (P3 wave 2); changes always go through setState swapping values/
// references (subscribers notice automatically); silent writes (draftHasContent etc., which the
// old version did not notify) only set, no bump.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { UiPrefs } from "./shapes";
import type { ContextDetailFrame, LimitsResultFrame, FileMatch, PromptAttachment, SlashCommand } from "../types/frames";
import { activeOpen, getSupportedThinkingForModel } from "./session";
import { saveRightSnapshot } from "./right";
import { detectLang } from "../i18n";

/** setTimeout handle (DOM vs Node return types differ; unified alias; TS environments with Node types return Timeout) */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface UiSlice {
  zoomLevel: number;
  isCommandPressed: boolean; // whether Command/Ctrl is currently held (shortcut hints)
  sidebarCollapsed: boolean;
  rightCollapsed: boolean;
  isCreatingNew: boolean;
  newSessionProject: string;
  newSessionBranch: string;
  newSessionBranches: string[]; // landed from the git_branches frame's branches (branch picker on the new-session page; list of branch names)
  newSessionIsGit: boolean;
  newSessionModel: string;
  newSessionThinking: string;
  newSessionPlanMode: boolean; // plan-mode intent for the next session (consumed by create_session; the host confirms via the plan_mode frame)
  defaultModelCfg: string | null; // landed from the models frame's defaultModel
  defaultThinkingCfg: string | null; // landed from the models frame's defaultThinking
  newSessionDirty: boolean;
  pendingFiles: (PromptAttachment & { id: number })[]; // composer attachment chips (carry a frontend-local id, stripped on send)
  fileSeq: number;
  animateGdKids: boolean;
  animateThinkBody: boolean;
  animateSubKids?: boolean; // subagent detail entrance-animation flag (attached at runtime, SubagentPage only)
  toastMsg: string | null; // current toast text (null = hidden)
  composerSetSignal: { text: string; images: unknown[] | null; seq: number; guard?: boolean } | null; // signal to fill the composer externally (fork backfill / queued-message editing); guard = async backfill, give up overwriting when the draft is non-empty
  findOpen: boolean; // in-session find bar open state (kept in sync by FindBar; guard before Esc interrupts generation)
  menuSignal: { name: string; seq: number } | null; // signal to open the composer menu externally (shortcut Alt+M)
  cyclePreview: { entries: { role: string; model: string }[]; activeRole: string; activeModel: string } | null; // ctrl+p quick-switch preview: the cycleOrder role list + the slot just switched to (drives the model menu's transient preview mode; manual menu opens always null it)
  thinkMenuAuto: boolean; // shift+tab auto-opened the think menu (normal content; auto-collapses on 0.8s pause / Shift release — manual opens always clear it)
  draftHasContent: boolean; // whether the composer has a draft (synced on every Composer render, used for the Esc double-confirm)
  escArmedUntil: number; // deadline of the Esc double-confirm window (> now = the send button shows a cancel icon)
  commands: SlashCommand[] | null; // slash command list of the current session (null = not fetched yet, the popover shows loading)
  commandsSessionId: string | null; // session id the list belongs to; invalidated on session switch
  mentionReqSeq: number; // list_files request counter (reqId generator, frontend-incremented)
  mentionResult: { reqId: number; matches: FileMatch[] } | null; // latest @ candidates response; stale as soon as the reqId no longer matches the current request
  ctxDetail: ContextDetailFrame | null; // most recent context_detail reply (ringpop popover transient, discard-on-leave)
  ctxLimits: LimitsResultFrame | null; // most recent limits_result reply
  mainViewMode: "chat" | "tree"; // main-area view mode (message stream vs session entry tree)
  // Agent Hub: middle-card roster of the session's subagents (opened by double-tap ← in an
  // empty composer). The right sidebar links to hubSel — it renders the linked detail page
  // while the hub is open and cannot be opened manually.
  hubOpen: boolean;
  hubSel: string | null; // selected subagentId
  hubMode: "flat" | "tree";
  hubRightWasCollapsed: boolean; // right panel state to restore on closeHub
  hubPrevTab: string | null; // rightTab to restore when the linked hub tab closes
  pendingOpenHub?: boolean; // pending hub open request during asynchronous session load
  pendingHubSel?: string | null;
  uiPrefs: UiPrefs;
  toast(msg: unknown): void;
  openHub(): void;
  closeHub(): void;
  setHubSel(id: string | null): void;
  toggleHubMode(): void;
  setComposerValue(text: string, images?: unknown[] | null, opts?: { guard?: boolean }): void;
  setMainViewMode(mode: "chat" | "tree"): void;
  showWelcomeScreen(preferredCwd?: string | null): void;
  hideWelcomeScreen(): void;
  setWelcomeProject(cwd?: string): void;
  initNewSessionModel(force?: boolean): void;
  pickModelId(id: string, role?: string): void;
  pickThinkingLevel(lv: string): void;
}

const uiPrefsInit: UiPrefs = {
  theme: "dark", // placeholder; main.tsx applies the cached/file value before the first render
  motion: "system", // placeholder; same
  uiFont: "default",
  uiFontSize: 13,
  codeFontSize: 12,
  lineNumbers: true,
  codeWrap: false,
  showThinking: true,
  expandToolOutput: true,
  lang: "zh-CN", // placeholder; resolved from the cache or detection below
  terminalInheritProfile: true,
  terminalFont: "",
};
// First-frame render cache (write-through mirror of omp-desktop.json's ui
// section; the file stays the source of truth and the ready frame reconciles
// any drift on every startup).
let storedUiPrefs: Partial<UiPrefs> = {};
try {
  storedUiPrefs = JSON.parse(localStorage.getItem("omp-ui-settings") || "{}");
} catch {}
Object.assign(uiPrefsInit, storedUiPrefs);
// Resolve the startup language: cached preference wins; otherwise detect from
// the system locale and persist the result so it survives restarts (the ready
// frame's uiConfig.locale corrects this against the file afterwards).
if (storedUiPrefs.lang !== "zh-CN" && storedUiPrefs.lang !== "en") {
  uiPrefsInit.lang = detectLang(undefined);
  try { localStorage.setItem("omp-ui-settings", JSON.stringify(uiPrefsInit)); } catch {}
}

// toast: the App-level Toast component consumes toastMsg (auto-hides after 2.2s)
let toastTimer: TimerHandle | undefined;
// Fill the composer externally (fork backfill / queued-message editing): a Composer component effect watches seq
let composerSetSeq = 0;

export const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set, get) => ({
  zoomLevel: 1,
  isCommandPressed: false,
  sidebarCollapsed: localStorage.getItem("omp-sidebar-collapsed") === "1",
  // Right panel collapsed by default (matching the old index.html <aside id="right" class="collapsed">); once manually expanded, remembered via localStorage
  rightCollapsed: localStorage.getItem("omp-right-collapsed") === null ? true : localStorage.getItem("omp-right-collapsed") === "1",
  isCreatingNew: false,
  newSessionProject: "",
  newSessionBranch: "",
  newSessionBranches: [],
  newSessionIsGit: false,
  newSessionModel: "",
  newSessionThinking: "auto",
  newSessionPlanMode: false,
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
  cyclePreview: null,
  thinkMenuAuto: false,
  draftHasContent: false,
  escArmedUntil: 0,
  commands: null,
  commandsSessionId: null,
  mentionReqSeq: 0,
  mentionResult: null,
  ctxDetail: null,
  ctxLimits: null,
  mainViewMode: "chat",
  hubOpen: false,
  hubSel: null,
  hubMode: "flat",
  hubRightWasCollapsed: false,
  hubPrevTab: null,
  pendingOpenHub: false,
  pendingHubSel: null,
  uiPrefs: uiPrefsInit,

  openHub() {
    const st = get();
    // Expand the right panel for the linked detail; inject the special "hub" tab (not
    // manually openable — only the hub linkage adds it) and activate it, remembering the
    // prior tab/collapse state for closeHub. The user may switch away while the hub stays
    // open and click back; closing the hub removes the tab.
    set({
      hubOpen: true,
      hubRightWasCollapsed: st.rightCollapsed,
      rightCollapsed: false,
      hubPrevTab: st.rightTab === "hub" ? st.hubPrevTab : st.rightTab,
      rightTabs: st.rightTabs.includes("hub") ? st.rightTabs : [...st.rightTabs, "hub"],
      rightTab: "hub",
    });
  },

  closeHub() {
    const st = get();
    set({
      hubOpen: false,
      hubSel: null,
      rightCollapsed: st.hubRightWasCollapsed,
      rightTabs: st.rightTabs.filter((n) => n !== "hub"),
      rightTab: st.rightTab === "hub" ? st.hubPrevTab : st.rightTab,
    });
    setTimeout(() => {
      (document.querySelector("#composer #input") as HTMLElement | null)?.focus();
    }, 0);
  },

  setHubSel(id) {
    set({ hubSel: id });
  },

  toggleHubMode() {
    set((s) => ({ hubMode: s.hubMode === "flat" ? "tree" : "flat" }));
  },

  toast(msg) {
    set((s) => ({ toastMsg: String(msg) }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      set((s) => ({ toastMsg: null }));
    }, 2200);
  },

  setComposerValue(text, images = [], opts) {
    set((s) => ({ composerSetSignal: { text, images, seq: ++composerSetSeq, ...(opts?.guard ? { guard: true } : {}) } }));
  },

  setMainViewMode(mode) {
    set({ mainViewMode: mode });
  },

  showWelcomeScreen(preferredCwd) {
    const alreadyOpen = get().isCreatingNew;
    saveRightSnapshot(get().activePath); // entering new-session page = leaving current session: snapshot before activePath is nulled
    set((s) => ({ isCreatingNew: true, activePath: null, mainViewMode: "chat" }));
    if (!alreadyOpen) {
      get().send({ type: "reload_settings" }); // the local config may have changed; pull the latest model settings
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
    set((s) => ({ isCreatingNew: false, mainViewMode: "chat" }));
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

  // force = new-session click / config-push refresh: model and level fall back to the config-file defaults; non-force only fills in missing values
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

  /** Model picked (shared by the model menu and Ctrl+P cycling): with a live session, sent via the host
   * (role set = the "Model Role" section pick; the host applies it through the CLI role path); in
   * new-session state, persisted, with the level falling back when invalid */
  pickModelId(id, role) {
    const s = activeOpen();
    if (s) {
      get().send({ type: "set_model", sessionId: s.sessionId, model: id, role });
      return;
    }
    set((st) => ({ newSessionModel: id, newSessionDirty: true })); // after a manual pick: later models frames no longer overwrite with the config default
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

  /** Thinking level picked (shared by the thinking menu and Shift+Tab cycling): with a live session, sent via the host; in new-session state, persisted */
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
