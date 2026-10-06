// Sidebar utilities (ported from ui/sidebar.js): relative time / duration formatting /
// session label / clipboard copy.
// fmtDuration is consumed later by chat-wave (the old version imported it from chat.js).
import { t } from "../../../i18n";

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

// Minimal structure needed for the session label (decoupled from SessionRow.SessionInfo so util doesn't depend back on components)
interface SessionLabelLike {
  title?: string | null; // host DiskSessionRow is string | null
  firstMessage?: string;
}

export function sessionLabel(s: SessionLabelLike): string {
  return s.title || s.firstMessage || t("sidebar.emptySession");
}

// Copy to clipboard (replica of shell.js copyText, incl. the WKWebView insecure-context fallback)
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

/** Whether a session is running (streaming or a bash tool in flight): shared by shortcut
 * candidate filtering and temporary project expansion while ⌘ is held */
export function isSessionRunning(
  open: { streaming?: boolean; items?: { role: string; running?: boolean }[] } | undefined,
): boolean {
  return !!(open && (open.streaming || open.items?.some((x) => x.role === "bash" && x.running)));
}

/**
 * Compute the sidebar session ⌘1~9 shortcut mapping:
 * 1. Priority: prefer jumping to running sessions; if fewer than 9 are running, fill with
 *    sessions having unread messages.
 * 2. Mapping: digits 1~9 follow the top-to-bottom order of the left session list.
 * Returns Map<sessionPath, digitString>
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
    // 1. Pinned sessions
    const pinnedRows = st.diskProjects
      .flatMap((p) => p.sessions)
      .filter((s) => st.pinnedSessions.has(s.path))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    for (const s of pinnedRows) append(s);

    // 2. Project list (iterate only expanded projects, or visible sessions in manage mode)
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
    // Archive view: archived sessions by modified time descending
    const list = st.archivedSessions ?? [];
    for (const s of list) append(s);
  } else {
    // Recent view: top 50 by modified descending
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

  // Priority filter: running first
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

  // Mapping: reorder candidates by the left list's order
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
