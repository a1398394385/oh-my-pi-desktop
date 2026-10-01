// 侧栏工具（ui/sidebar.js 平移）：相对时间 / 时长格式化 / 会话标签 / 剪贴板复制。
// fmtDuration 供后续 chat-wave 消费（原版由 chat.js 引入）。
import { t } from "../../i18n";

export function fmtAgo(iso: string): string {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return t("sidebar.agoNow");
  if (sec < 3600) return t("sidebar.agoMin", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("sidebar.agoHour", { n: Math.floor(sec / 3600) });
  return t("sidebar.agoDay", { n: Math.floor(sec / 86400) });
}

export function fmtDuration(sec: number): string {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return t("sidebar.durSec", { n: sec });
  const m = Math.floor(sec / 60);
  return t("sidebar.durMinSec", { m, s: String(sec % 60).padStart(2, "0") });
}

// 会话标签所需的最小结构（与 SessionRow.SessionInfo 解耦，避免 util 反向依赖组件）
interface SessionLabelLike {
  title?: string | null; // 宿主 DiskSessionRow 为 string | null
  firstMessage?: string;
}

export function sessionLabel(s: SessionLabelLike): string {
  return s.title || s.firstMessage || t("sidebar.emptySession");
}

// 复制到剪贴板（shell.js copyText 同款复刻，含 WKWebView 非安全上下文兜底）
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

export interface ShortcutSessionCandidate {
  path: string;
  modified: string;
  cwd?: string;
}

export interface ShortcutComputationState {
  viewMode: string;
  diskProjects: { cwd: string; sessions: ShortcutSessionCandidate[] }[];
  pinnedSessions: Set<string>;
  expandedProjects: Set<string>;
  projectLimits: Map<string, number>;
  isProjectManageMode: boolean;
  openSessions: Map<string, { streaming?: boolean; items?: { role: string; running?: boolean }[] }>;
  unseenFinished: Set<string>;
  removedProjects?: string[] | Set<string>;
  availableProjects?: { cwd: string; sessions: ShortcutSessionCandidate[] }[];
  getAvailableProjects?: () => { cwd: string; sessions: ShortcutSessionCandidate[] }[];
  archivedSessions?: ShortcutSessionCandidate[];
}

export const SHORTCUT_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** 会话是否正在运行（流式中或有 bash 工具在跑）：快捷键候选筛选与 ⌘ 按住时临时展开项目共用 */
export function isSessionRunning(
  open: { streaming?: boolean; items?: { role: string; running?: boolean }[] } | undefined,
): boolean {
  return !!(open && (open.streaming || open.items?.some((x) => x.role === "bash" && x.running)));
}

/**
 * 计算侧栏会话 ⌘1~9 快捷键映射：
 * 1. 优先级：优先跳转到正在运行中的会话；若运行中不足 9 个，用存在未读消息的会话补齐。
 * 2. 对应关系：数字 1~9 的顺序与左侧会话列表从上到下的顺序保持一致。
 * 返回 Map<sessionPath, digitString>
 */
export function computeSidebarSessionShortcuts(st: ShortcutComputationState): Map<string, string> {
  const orderedSessions: ShortcutSessionCandidate[] = [];
  const seen = new Set<string>();

  const append = (s: ShortcutSessionCandidate) => {
    if (!s || !s.path || seen.has(s.path)) return;
    seen.add(s.path);
    orderedSessions.push(s);
  };

  if (st.viewMode === "project") {
    // 1. 置顶会话
    const pinnedRows = st.diskProjects
      .flatMap((p) => p.sessions)
      .filter((s) => st.pinnedSessions.has(s.path))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    for (const s of pinnedRows) append(s);

    // 2. 项目列表（只遍历展开的项目或清理模式下的可见会话）
    const removedSet = st.removedProjects instanceof Set
      ? st.removedProjects
      : new Set(st.removedProjects ?? []);
    const projects = st.availableProjects
      ? st.availableProjects
      : st.getAvailableProjects
      ? st.getAvailableProjects()
      : st.diskProjects.filter((p) => !removedSet.has(p.cwd));

    for (const p of projects) {
      const isExpanded = st.isProjectManageMode || st.expandedProjects.has(p.cwd);
      if (!isExpanded) continue;
      const limit = st.isProjectManageMode ? Infinity : (st.projectLimits.get(p.cwd) ?? 5);
      const visible = p.sessions.slice(0, limit);
      for (const s of visible) append(s);
    }
  } else if (st.viewMode === "archive") {
    // 归档视图：按修改时间倒序的归档会话
    const list = st.archivedSessions ?? [];
    for (const s of list) append(s);
  } else {
    // 最近视图：前 50 条按 modified 倒序
    const flat = st.diskProjects
      .flatMap((p) => p.sessions)
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
      .slice(0, 50);
    for (const s of flat) append(s);
  }

  const isRunning = (path: string) => isSessionRunning(st.openSessions.get(path));

  const isUnread = (path: string) => {
    return st.unseenFinished.has(path);
  };

  // 优先级筛选：运行中优先
  const runningSessions = orderedSessions.filter((s) => isRunning(s.path));
  let candidates: ShortcutSessionCandidate[] = [];

  if (runningSessions.length >= SHORTCUT_DIGITS.length) {
    candidates = runningSessions.slice(0, SHORTCUT_DIGITS.length);
  } else {
    candidates = [...runningSessions];
    const needed = SHORTCUT_DIGITS.length - candidates.length;
    const runningSet = new Set(candidates.map((s) => s.path));
    const unreadSessions = orderedSessions.filter((s) => isUnread(s.path) && !runningSet.has(s.path));
    candidates.push(...unreadSessions.slice(0, needed));
  }

  // 对应关系：候选条目按左侧列表顺序重排
  const candidateSet = new Set(candidates.map((s) => s.path));
  const finalOrdered = orderedSessions.filter((s) => candidateSet.has(s.path));

  const result = new Map<string, string>();
  finalOrdered.forEach((s, idx) => {
    if (idx < SHORTCUT_DIGITS.length) {
      result.set(s.path, SHORTCUT_DIGITS[idx]);
    }
  });

  return result;
}
