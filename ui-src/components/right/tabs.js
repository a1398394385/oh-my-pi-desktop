// 右栏 tab 管理：打开的 tab 有序列表 + 当前激活项；全部关闭后激活项为 null（起始页）。
// 自 RightPanel.jsx 拆出（各页面组件也要 openRightTab，独立模块避免与面板组件循环依赖）。
import { S, notify } from "../../store.js";

export const TAB_META = {
  subagent: { label: "子代理", icon: "agents" },
  gitdiff: { label: "Git Diff", icon: "branch" },
  bgcmd: { label: "后台命令", icon: "term" },
  file: { label: "文件", icon: "folderOpen" },
  tree: { label: "分支", icon: "fork" },
};
export const rightTabs = ["subagent"]; // 已打开 tab（有序）

export function openRightTab(name) {
  if (!rightTabs.includes(name)) rightTabs.push(name);
  S.rightTab = name;
  notify();
}

export function closeRightTab(name) {
  const i = rightTabs.indexOf(name);
  if (i < 0) return;
  rightTabs.splice(i, 1);
  if (S.rightTab === name) S.rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  notify();
}
