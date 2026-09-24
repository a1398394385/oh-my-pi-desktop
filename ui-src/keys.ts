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
// 故中断只在没有其它 Esc 消费者时触发（见 interrupt 的守卫）。
// 绑定在组件内的键（⌘N 新建 / ⌘, 设置 / ⌘F 查找 / 缩放 / 输入框内各键）只在此登记展示，
// 不在此重复绑定——重复绑定即双触发。
import {
  useAppStore, setBump, send, toast, activeOpen,
  getSupportedThinkingForModel, pickModelId, pickThinkingLevel, toolExpandKey,
  type TimerHandle,
} from "./store";
import { saveUiPrefs, applyAppearance } from "./appearance";
import { toggleSidebar, toggleRightPanel, closeAllMenus } from "./shell";

// ---------- 动作 ----------

// 有草稿时 Esc 的二次确认窗口（第一下示警 → 窗口内第二下才中断）
const ESC_ARM_MS = 500;
let escArmTimer: TimerHandle | undefined;

/** app.interrupt：中断当前生成（或运行中的本地命令，与停止钮同路由）。
    输入框有草稿时需连按两下：第一下只把发送钮短暂切到取消图标示警，0.5s 内第二下才真正中断。 */
function interrupt(): boolean | undefined {
  const st = useAppStore.getState();
  if (st.settingsOpen || st.findOpen) return false; // 设置 / 查找栏先吃 Esc（各自容器处理）
  if (document.querySelector(".menu.open")) {
    closeAllMenus(); // 打开中的弹层先关（输入区菜单 / 设置页下拉）
    return false;
  }
  const s = activeOpen();
  const bashRunning = !!s?.items?.some((x) => x.role === "bash" && x.running);
  if (!s || (!s.streaming && !bashRunning)) return false;
  if (st.draftHasContent && Date.now() > st.escArmedUntil) {
    setBump({ escArmedUntil: Date.now() + ESC_ARM_MS }); // 写+bump：发送钮切到取消图标
    clearTimeout(escArmTimer);
    escArmTimer = setTimeout(() => {
      setBump({ escArmedUntil: 0 });
    }, ESC_ARM_MS + 20);
    return false;
  }
  setBump({ escArmedUntil: 0 });
  send({ type: bashRunning && !s.streaming ? "bash_abort" : "abort_session", sessionId: s.sessionId });
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
      { keys: ["Esc"], chords: ["escape"], label: "中断生成（有草稿时连按两下）", run: interrupt },
      { keys: ["⌘", "N"], label: "新建任务" },
      { keys: ["⌘", "B"], chords: ["meta+b"], label: "切换左侧边栏", run: toggleSidebar },
      { keys: ["⌘", ","], label: "打开 / 关闭设置" },
      { keys: ["Esc"], label: "关闭设置 / 查找栏 / 弹层" },
      { keys: ["⌘", "F"], label: "会话内查找" },
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
      { keys: ["⌘", "+"], label: "放大" },
      { keys: ["⌘", "−"], label: "缩小" },
      { keys: ["⌘", "0"], label: "重置缩放" },
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

function onKeyDown(e: KeyboardEvent): void {
  const item = BINDINGS.get(chordOf(e));
  if (!item?.run) return;
  if (item.run(e) === false) return; // 动作自判上下文：未处理则不拦截默认行为
  e.preventDefault();
}

/** 挂载全局快捷键监听（App 启动时调用一次） */
export function initKeys(): void {
  document.addEventListener("keydown", onKeyDown);
}
