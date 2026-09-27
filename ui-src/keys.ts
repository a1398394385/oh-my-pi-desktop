// 全局快捷键：注册表（设置页「键盘快捷键」的展示数据源）+ 唯一的 keydown 分派。
// 键位抄 OMP CLI（oh-my-pi 的 docs/keybindings.md 与 packages/tui/src/app-keybindings.ts 的
// app.* 动作），只迁移桌面端有对应动作的键：
//   · TUI 编辑器键（Ctrl+A/E/K/U/W、Ctrl+Y、Alt+B/F、Ctrl+]/Alt+]）不迁移——macOS WebView
//     已有系统惯例（⌘←/→ 行首尾、⌥←/→ 词移、⌥⌫ 删词、⌘A 全选），覆盖会破坏用户预期；
//   · 终端专属键（Ctrl+Z suspend、Ctrl+D 退出、Alt+L 重置显示、Ctrl+G 外部编辑器、
//     Ctrl+L live 语音、空格长按 STT、Ctrl+Shift+V 原始粘贴）无对应能力，不迁移；
//   · app.history.search / app.retry / app.tools.toggleVisibility / app.session.*
//     桌面端无对应动作，不迁移。
// 与 CLI 的差异：CLI 里 Esc 独占中断语义，GUI 里 Esc 已被设置页/查找栏/打开中的弹层消费，
// 故 Esc 路由只在没有其它 Esc 消费者时触发（见 handleEsc 的守卫）。
// 绑定在组件内的键（⌘N 新建 / ⌘, 设置 / ⌘F 查找 / 缩放 / 输入框内各键）只在此登记展示，
// 不在此重复绑定——重复绑定即双触发。
import {
  useAppStore, setBump, send, toast, activeOpen, openSessionByPath, getAvailableProjects,
  getSupportedThinkingForModel, pickModelId, pickThinkingLevel, toolExpandKey,
  type TimerHandle,
} from "./store";
import { saveUiPrefs, applyAppearance } from "./appearance";
import { toggleSidebar, toggleRightPanel, closeAllMenus } from "./shell";
import { IS_WINDOWS, MOD, modDown } from "./platform";
import { computeSidebarSessionShortcuts, isSessionRunning } from "./components/sidebar/util";

// ---------- 动作 ----------

// 连按 Esc 动作窗口（500ms）
const DOUBLE_ESC_MS = 500;
let doubleEscTimer: TimerHandle | undefined;
let escArmedAction: "clear" | "tree" | null = null;

/** 全局 Esc 路由：
 *  1. tree 页面：按一下 esc 切回消息；
 *  2. 输入框有文字时：按两下 esc 清空输入框；
 *  3. 输入框无文字时：按两下 esc 唤起 tree（生成中第一下先中止生成）。
 */
function handleEsc(): boolean | undefined {
  const st = useAppStore.getState();
  if (st.settingsOpen || st.findOpen) return false; // 设置 / 查找栏先吃 Esc
  if (document.querySelector(".menu.open")) {
    closeAllMenus(); // 打开中的弹层先关（输入区菜单 / 设置页下拉）
    return false;
  }
  if (document.querySelector(".lp-mask")) {
    return false; // 树跳转确认等模态弹窗先关
  }

  // 1. tree 页面：按一下 esc 切回消息
  if (st.mainViewMode === "tree") {
    st.setMainViewMode("chat");
    setTimeout(() => {
      const inp = document.querySelector("#composer #input") as HTMLElement | null;
      inp?.focus();
    }, 0);
    return true;
  }

  // 处于 clear 确认阶段的第二下 Esc：执行清空
  if (escArmedAction === "clear") {
    clearTimeout(doubleEscTimer);
    escArmedAction = null;
    setBump({ escArmedUntil: 0 });
    st.setComposerValue("", []);
    return true;
  }

  // 处于 tree 确认阶段的第二下 Esc：唤起 tree
  if (escArmedAction === "tree") {
    clearTimeout(doubleEscTimer);
    escArmedAction = null;
    st.setMainViewMode("tree");
    return true;
  }

  const s = activeOpen();
  const bashRunning = !!s?.items?.some((x) => x.role === "bash" && x.running);
  const hasText = !!(st.draftHasContent || (st.pendingFiles && st.pendingFiles.length > 0));

  // 2. 输入框有文字时：按第一下 Esc 提示清空（无 toast，发送钮短暂转取消图标即提示）
  if (hasText) {
    escArmedAction = "clear";
    setBump({ escArmedUntil: Date.now() + DOUBLE_ESC_MS });
    clearTimeout(doubleEscTimer);
    doubleEscTimer = setTimeout(() => {
      escArmedAction = null;
      setBump({ escArmedUntil: 0 });
    }, DOUBLE_ESC_MS + 20);
    return false;
  }

  // 3. 输入框无文字时：生成中第一下先中止生成
  if (s && (s.streaming || bashRunning)) {
    send({ type: bashRunning && !s.streaming ? "bash_abort" : "abort_session", sessionId: s.sessionId });
    return true;
  }

  // 4. 输入框无文字时：记录 tree 动作窗口，静默等待第二下 Esc 唤起 tree
  if (!s && !st.isCreatingNew) return false;
  escArmedAction = "tree";
  clearTimeout(doubleEscTimer);
  doubleEscTimer = setTimeout(() => {
    escArmedAction = null;
  }, DOUBLE_ESC_MS + 20);
  return false;
}

/** app.model.cycleForward / cycleBackward：按宿主下发顺序（与模型菜单同序）前后移动 */
function cycleModel(delta: number): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (!s && !st.isCreatingNew) return;
  const ids = [...st.modelNames.keys()];
  if (ids.length === 0) {
    toast("未配置可用模型");
    return;
  }
  const cur = s?.model || st.newSessionModel;
  const i = ids.indexOf(cur);
  pickModelId(i < 0 ? ids[delta > 0 ? 0 : ids.length - 1] : ids[(i + delta + ids.length) % ids.length]);
}

/** app.thinking.cycle：在当前模型支持的档位里循环（auto → off → 各档 → auto） */
function cycleThinking(): void {
  const st = useAppStore.getState();
  const s = activeOpen();
  if (!s && !st.isCreatingNew) return;
  const levels = getSupportedThinkingForModel(s?.model || st.newSessionModel);
  if (levels.length === 0) return;
  pickThinkingLevel(levels[(levels.indexOf(s?.thinking || st.newSessionThinking) + 1) % levels.length]);
}

/** app.model.select：打开模型选择菜单（Composer 消费 menuSignal） */
function openModelMenu(): void {
  const st = useAppStore.getState();
  if (st.settingsOpen) return; // 设置覆盖层下的菜单不可见，不开
  if (!activeOpen() && !st.isCreatingNew) return;
  setBump({ menuSignal: { name: "model", seq: (st.menuSignal?.seq ?? 0) + 1 } });
}

/** app.plan.toggle：计划模式开合（仅会话内，与权限模式菜单同路由） */
function togglePlanMode(): void {
  const s = activeOpen();
  if (!s) return;
  send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !s.planMode });
}

/** app.agents.hub：右侧边栏开合（与顶栏右栏按钮同路由） */
function toggleSubagents(): void {
  toggleRightPanel();
}

/** app.thinking.toggle：思考标签「运行中默认展开、结束收起」开关（= 外观页「显示思考过程」） */
function toggleThinking(): void {
  const showThinking = !useAppStore.getState().uiPrefs.showThinking;
  // 写换新对象（selector 组件按引用感知）+ _v bump（原「写+notify」）；末尾 toast 自带一次 bump
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking } }));
  saveUiPrefs();
  applyAppearance();
  // 同步宿主设置：不回写会被下一次 settings/ready 帧的 hideThinkingBlock 覆盖回弹
  send({ type: "set_setting", key: "hideThinkingBlock", value: !showThinking });
  // 即时反馈：只跟正在流式的思考行（已结束的收起态、用户手动展开的行都不动）
  const s = activeOpen();
  if (s) {
    for (const it of s.items) {
      if (it.role === "thinking" && it.streaming) it.expanded = showThinking;
    }
  }
  toast(showThinking ? "思考过程：运行时展开" : "思考过程：运行时保持收起");
}

/** app.tools.expand：工具输出「运行中默认展开、结束收起」开关 */
function toggleToolOutput(): void {
  const expandToolOutput = !useAppStore.getState().uiPrefs.expandToolOutput;
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, expandToolOutput } }));
  saveUiPrefs();
  // 即时反馈：只跟正在运行的工具行（已结束的行保持用户当前的收展态）
  const s = activeOpen();
  if (s) {
    for (const it of s.items) {
      if (it.role === "tool" && it.running) it[toolExpandKey(it.name)] = expandToolOutput;
    }
  }
  toast(expandToolOutput ? "工具输出：运行时展开" : "工具输出：运行时保持收起");
}

/** Command/Ctrl + 1~9：跳转到左侧会话（优先运行中，不足 9 个用未读补齐） */
function handleSessionJump(digit: string): boolean {
  const st = useAppStore.getState();
  if (st.settingsOpen) return false;
  if (document.querySelector(".lp-mask")) return false;

  // 与侧栏徽标同源取可见项目（allProjects 顺序 + 历史项目兜底），保证按键跳转与显示一致
  const shortcuts = computeSidebarSessionShortcuts({ ...st, availableProjects: getAvailableProjects() });
  for (const [path, d] of shortcuts.entries()) {
    if (d === digit) {
      openSessionByPath(path);
      setTimeout(() => {
        const inp = document.querySelector("#composer #input") as HTMLElement | null;
        inp?.focus();
      }, 0);
      return true;
    }
  }
  return false;
}

// ---------- 注册表 ----------
// keys = 键帽展示；chords = 分派用键位（空 = 绑定在组件内，此处只登记）；run = 动作
export interface ShortcutItem {
  keys: string[];
  chords?: string[];
  label: string;
  run?: (e?: KeyboardEvent) => unknown; // 动作自判上下文：返回 false = 未处理（不拦截默认行为）
}
export interface ShortcutGroup {
  title: string;
  desc: string;
  items: ShortcutItem[];
}
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "通用",
    desc: "全局快捷键，在任何界面都可以使用。",
    items: [
      { keys: ["Esc"], chords: ["escape"], label: "Esc 路由：无字双击开树 / 树页单击回对话 / 有字双击清空", run: handleEsc },
      { keys: [MOD, "N"], label: "新建任务" },
      { keys: [MOD, "1~9"], label: "跳转至对应会话（运行中优先，未读补齐）" },
      { keys: [MOD, "B"], chords: ["meta+b"], label: "切换左侧边栏", run: toggleSidebar },
      { keys: [MOD, ","], label: "打开 / 关闭设置" },
      { keys: ["Esc"], label: "关闭设置 / 查找栏 / 弹层" },
      { keys: [MOD, "F"], label: "会话内查找" },
      { keys: ["Alt", "A"], chords: ["alt+a"], label: "切换右侧边栏", run: toggleSubagents },
    ],
  },
  {
    title: "模型与思考",
    desc: "键位对齐 omp 命令行。",
    items: [
      { keys: ["Ctrl", "P"], chords: ["ctrl+p"], label: "下一个模型", run: () => cycleModel(1) },
      { keys: ["Ctrl", "⇧", "P"], chords: ["ctrl+shift+p"], label: "上一个模型", run: () => cycleModel(-1) },
      { keys: ["Alt", "M"], chords: ["alt+m"], label: "打开模型选择", run: openModelMenu },
      { keys: ["⇧", "Tab"], chords: ["shift+tab"], label: "循环思考级别", run: cycleThinking },
      { keys: ["Ctrl", "T"], chords: ["ctrl+t"], label: "思考过程：运行时默认展开", run: toggleThinking },
      { keys: ["Alt", "⇧", "P"], chords: ["alt+shift+p"], label: "计划模式开关", run: togglePlanMode },
    ],
  },
  {
    title: "过程显示",
    desc: "思考与工具输出在运行期间的默认展开。",
    items: [
      { keys: ["Ctrl", "O"], chords: ["ctrl+o"], label: "工具输出：运行时默认展开", run: toggleToolOutput },
    ],
  },
  {
    title: "输入框",
    desc: "会话输入框内的按键行为。",
    items: [
      { keys: ["↵"], label: "发送消息" },
      { keys: ["⇧", "↵"], label: "换行" },
      { keys: ["Ctrl", "↵"], label: "立即注入（生成中 steer）" },
      { keys: ["Ctrl", "Q"], label: "加入待发送队列" },
      { keys: ["Alt", "↑"], label: "拉回排队消息（后发先回）" },
    ],
  },
  {
    title: "界面缩放",
    desc: "调整整个界面的显示比例。",
    items: [
      { keys: [MOD, "+"], label: "放大" },
      { keys: [MOD, "−"], label: "缩小" },
      { keys: [MOD, "0"], label: "重置缩放" },
    ],
  },
];

// ---------- 分派 ----------
const BINDINGS = new Map<string, ShortcutItem>();
for (const g of SHORTCUT_GROUPS) {
  for (const it of g.items) for (const c of it.chords ?? []) BINDINGS.set(c, it);
}

/** 归一化按键：字母/数字取 e.code（macOS 的 Option 组合会改写 e.key，如 ⌥P 得到 "π"） */
function chordOf(e: KeyboardEvent): string {
  const code = e.code || "";
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  const key = letter ? letter[1].toLowerCase() : digit ? digit[1] : (e.key || "").toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  parts.push(key);
  return parts.join("+");
}

// ---------- ⌘ 按住态与项目临时展开 ----------
// 按住 ⌘ 时把含运行中会话的折叠项目临时展开（纯前端视觉态：不发 set_project_expanded、
// 不落盘），让运行中会话的行与徽标可见；松开时只回收自动展开的那批——按住期间用户的
// 手动展开/折叠（走 ProjGroup 正常路径、含落盘）不受影响。
let autoExpandedProjects: Set<string> | null = null;

function setCommandPressed(on: boolean): void {
  const st = useAppStore.getState();
  if (st.isCommandPressed === on) return;
  if (!on) {
    if (autoExpandedProjects) {
      const cur = useAppStore.getState();
      useAppStore.setState({
        isCommandPressed: false,
        expandedProjects: new Set([...cur.expandedProjects].filter((c) => !autoExpandedProjects!.has(c))),
      });
      autoExpandedProjects = null;
    } else {
      useAppStore.setState({ isCommandPressed: false });
    }
    return;
  }
  // 清理模式本就全展开，无需临时展开
  const toExpand = new Set<string>();
  if (!st.isProjectManageMode) {
    for (const p of getAvailableProjects()) {
      if (st.expandedProjects.has(p.cwd)) continue;
      if (p.sessions.some((s) => isSessionRunning(st.openSessions.get(s.path)))) toExpand.add(p.cwd);
    }
  }
  autoExpandedProjects = toExpand.size > 0 ? toExpand : null;
  useAppStore.setState(
    toExpand.size > 0
      ? { isCommandPressed: true, expandedProjects: new Set([...st.expandedProjects, ...toExpand]) }
      : { isCommandPressed: true },
  );
}

function onKeyDown(e: KeyboardEvent): void {
  // 修饰键按下态：按住 Command（Windows 下 Ctrl）激活侧栏快捷键徽标提示 + 临时展开
  if (modDown(e)) {
    setCommandPressed(true);
  }

  // 快捷键跳转会话：Command/Ctrl + 1~9（⌘0 保留给重置缩放，绑定在 shell.ts 全局监听）
  if (modDown(e) && !e.altKey && !e.shiftKey) {
    const codeM = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    const digit = codeM?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null);
    if (digit && handleSessionJump(digit)) {
      e.preventDefault();
      return;
    }
  }

  let item = BINDINGS.get(chordOf(e));
  // ⌘ 键位在 Windows 落到 Ctrl：原 chord 未命中时把 ctrl 换成 meta 再查一次
  // （ctrl+X 的既有绑定在前一步已优先命中，不受影响）
  if (!item && IS_WINDOWS && e.ctrlKey && !e.metaKey) {
    item = BINDINGS.get(chordOf(e).replace("ctrl", "meta"));
  }
  if (!item?.run) return;
  if (item.run(e) === false) return; // 动作自判上下文：未处理则不拦截默认行为
  e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  // 当修饰键松开时关闭视觉提示并回收临时展开的项目
  if (!modDown(e) || (IS_WINDOWS ? e.key === "Control" : e.key === "Meta")) {
    setCommandPressed(false);
  }
}

function onBlur(): void {
  setCommandPressed(false);
}

/** 挂载全局快捷键监听（App 启动时调用一次） */
export function initKeys(): void {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onBlur();
  });
}
