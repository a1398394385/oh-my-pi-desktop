// 右栏 tab 管理：打开的 tab 有序列表 + 当前激活项；全部关闭后激活项为 null（起始页）。
// 自 RightPanel.jsx 拆出（各页面组件也要 openRightTab，独立模块避免与面板组件循环依赖）。
// tab 列表与最近关闭在 store（rightTabs / rightRecentClosed），操作换引用写入，
// 字段订阅自动通知（不再依赖 _v bump）。
import { useAppStore, setBump } from "../../store";

// 右栏 tab 元信息（图标名走 ui/icons 注册表）
interface TabMeta {
  label: string;
  icon: string;
}

export const TAB_META: Record<string, TabMeta> = {
  subagent: { label: "子代理", icon: "agents" },
  gitdiff: { label: "Git Diff", icon: "branch" },
  bgcmd: { label: "后台命令", icon: "term" },
  file: { label: "文件", icon: "folderOpen" },
  tree: { label: "分支", icon: "fork" },
  sessiontree: { label: "会话树", icon: "tree" },
  terminal: { label: "终端", icon: "termBox" },
  browser: { label: "浏览器", icon: "globe" },
};
// tab 关闭钩子：页面有宿主侧资源（如终端 PTY）时注册，关 tab 前回调销毁
//（TerminalPage 用：关「终端」tab 杀 pty-bridge 子进程）
const tabCloseHooks: Record<string, () => void> = {};
export function registerTabCloseHook(name: string, fn: () => void): void {
  tabCloseHooks[name] = fn;
}
// 最近关闭封顶条数（新→旧）
const RECENT_MAX = 5;

export function openRightTab(name: string): void {
  useAppStore.setState((st) => ({
    rightTabs: st.rightTabs.includes(name) ? st.rightTabs : [...st.rightTabs, name],
    // 重开/打开时从「最近关闭」摘除，避免列表残留已开项
    rightRecentClosed: st.rightRecentClosed.some((x) => x.name === name)
      ? st.rightRecentClosed.filter((x) => x.name !== name)
      : st.rightRecentClosed,
    rightTab: name,
  }));
}

/** 底栏按钮与快捷键（Alt+A）共用的 tab 开关：已开且当前 → 收起右栏；否则切到该 tab 并展开 */
export function toggleRightTab(name: string): void {
  const st = useAppStore.getState();
  if (!st.rightCollapsed && st.rightTab === name) {
    setBump({ rightCollapsed: true });
  } else {
    openRightTab(name); // 未开则加入 tab 列表并激活
    setBump({ selectedFile: null, selectedSubagent: null, rightCollapsed: false, todoCollapsed: true }); // 展开右栏时进程卡让位收起（parts.jsx 同款）
  }
}

export function closeRightTab(name: string): void {
  const st = useAppStore.getState();
  const i = st.rightTabs.indexOf(name);
  if (i < 0) return;
  tabCloseHooks[name]?.(); // 页面宿主资源销毁（PTY 等），先于列表摘除
  const tabs = st.rightTabs.slice();
  tabs.splice(i, 1);
  // 记入最近关闭（去重置顶、封顶 5）
  const recent = st.rightRecentClosed.filter((x) => x.name !== name);
  recent.unshift({ name, at: Date.now() });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  useAppStore.setState({
    rightTabs: tabs,
    rightRecentClosed: recent,
    // 关闭的是当前 tab：激活项回落到邻近 tab；否则不变（tab 列表变化由字段订阅通知）
    rightTab: st.rightTab === name ? tabs[Math.min(i, tabs.length - 1)] ?? null : st.rightTab,
  });
}

// 总览 popover「最近关闭」点击重开：从最近列表摘除后走常规打开（摘除内联在 openRightTab）
export function reopenRightTab(name: string): void {
  openRightTab(name);
}

// tab 头拖拽重排（原生 HTML5 DnD）：把 name 移到 before 之前；before 为空表示移到末尾
export function moveRightTab(name: string, before: string | null): void {
  const tabs = useAppStore.getState().rightTabs;
  const from = tabs.indexOf(name);
  if (from < 0 || name === before) return;
  const next = tabs.slice();
  next.splice(from, 1);
  const to = before ? next.indexOf(before) : next.length;
  next.splice(to < 0 ? next.length : to, 0, name);
  useAppStore.setState({ rightTabs: next }); // 换引用写入：读 rightTabs 的组件经字段订阅重渲染
}
