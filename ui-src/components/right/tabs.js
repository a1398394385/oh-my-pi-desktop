// 右栏 tab 管理：打开的 tab 有序列表 + 当前激活项；全部关闭后激活项为 null（起始页）。
// 自 RightPanel.jsx 拆出（各页面组件也要 openRightTab，独立模块避免与面板组件循环依赖）。
import { S, notify } from "../../store.js";

export const TAB_META = {
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
const tabCloseHooks = {};
export function registerTabCloseHook(name, fn) {
  tabCloseHooks[name] = fn;
}
export const rightTabs = ["subagent"]; // 已打开 tab（有序）
export const rightRecentClosed = []; // 最近关闭（新→旧，最多 5 条）：总览 popover「最近关闭」组数据源
const RECENT_MAX = 5;

export function openRightTab(name) {
  if (!rightTabs.includes(name)) rightTabs.push(name);
  // 重开/打开时从「最近关闭」摘除，避免列表残留已开项
  const r = rightRecentClosed.findIndex((x) => x.name === name);
  if (r >= 0) rightRecentClosed.splice(r, 1);
  S.rightTab = name;
  notify();
}

/** 底栏按钮与快捷键（Alt+A）共用的 tab 开关：已开且当前 → 收起右栏；否则切到该 tab 并展开 */
export function toggleRightTab(name) {
  if (!S.rightCollapsed && S.rightTab === name) {
    S.rightCollapsed = true;
  } else {
    openRightTab(name); // 未开则加入 tab 列表并激活
    S.selectedFile = null;
    S.selectedSubagent = null;
    S.rightCollapsed = false;
    S.todoCollapsed = true; // 展开右栏时进程卡让位收起（parts.jsx 同款）
  }
  notify();
}

export function closeRightTab(name) {
  const i = rightTabs.indexOf(name);
  if (i < 0) return;
  tabCloseHooks[name]?.(); // 页面宿主资源销毁（PTY 等），先于列表摘除
  rightTabs.splice(i, 1);
  // 记入最近关闭（去重置顶、封顶 5）
  const r = rightRecentClosed.findIndex((x) => x.name === name);
  if (r >= 0) rightRecentClosed.splice(r, 1);
  rightRecentClosed.unshift({ name, at: Date.now() });
  if (rightRecentClosed.length > RECENT_MAX) rightRecentClosed.length = RECENT_MAX;
  if (S.rightTab === name) S.rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  notify();
}

// 总览 popover「最近关闭」点击重开：从最近列表摘除后走常规打开
export function reopenRightTab(name) {
  const r = rightRecentClosed.findIndex((x) => x.name === name);
  if (r >= 0) rightRecentClosed.splice(r, 1);
  openRightTab(name);
}

// tab 头拖拽重排（原生 HTML5 DnD）：把 name 移到 before 之前；before 为空表示移到末尾
export function moveRightTab(name, before) {
  const from = rightTabs.indexOf(name);
  if (from < 0 || name === before) return;
  rightTabs.splice(from, 1);
  const to = before ? rightTabs.indexOf(before) : rightTabs.length;
  rightTabs.splice(to < 0 ? rightTabs.length : to, 0, name);
  notify();
}
