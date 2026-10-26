// Sidebar utilities (ported from ui/sidebar.js): relative time formatting /
// session label / clipboard copy.
// fmtAgo is the single shared definition (consumed by tree/SessionTreeStream);
// fmtDuration lives in chat/util.ts.
import { t } from "../../../i18n";

export function fmtAgo(iso: string): string {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return t("sidebar.agoNow");
  if (sec < 3600) return t("sidebar.agoMin", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("sidebar.agoHour", { n: Math.floor(sec / 3600) });
  return t("sidebar.agoDay", { n: Math.floor(sec / 86400) });
}

// Minimal structure needed for the session label (decoupled from SessionRow.SessionInfo so util doesn't depend back on components)
interface SessionLabelLike {
  title?: string | null; // host DiskSessionRow is string | null
  firstMessage?: string;
}

export function sessionLabel(s: SessionLabelLike): string {
  // The base scanner stamps this sentinel when its 4 KB prefix window holds no message
  // entry (dense custom injections push the first message past it). It is not a title.
  const first = s.firstMessage === "(no messages)" ? "" : s.firstMessage;
  return s.title || first || t("sidebar.emptySession");
}

// Copy to clipboard (replica of shell.js copyText, incl. the WKWebView insecure-context fallback)
export function copyText(text: string): Promise<void> {
  // WKWebView keeps navigator.clipboard present but rejects writeText when the webview is not
  // focused / the call has no user activation, so execCommand must also cover the reject path
  // (same two-branch fallback as ui/markdown.js copyCodeBlock).
  const execFallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  };
  if (!navigator.clipboard?.writeText) {
    execFallback();
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(text).catch(() => execFallback());
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

/** Project-order source for archive grouping (structural subset of getAvailableProjects rows). */
export interface ArchiveProjectOrder {
  cwd: string;
  remote?: boolean;
  remoteLabel?: string;
  isDefault?: boolean;
}

/**
 * Group archived sessions by project for the archive view (mirrors the project view):
 * groups follow the available-projects order; archived cwds missing from that list are
 * appended as fallback groups in first-seen order (archivedSessions arrives sorted by
 * modified descending, so first-seen = newest group first). Empty groups are dropped —
 * groups are driven by archived rows, never by the project manifest.
 */
export function computeArchiveGroups<T extends { cwd?: string; modified: string }>(
  archived: T[],
  availableProjects: ArchiveProjectOrder[],
): (ArchiveProjectOrder & { sessions: T[] })[] {
  const byCwd = new Map<string, ArchiveProjectOrder & { sessions: T[] }>();
  for (const p of availableProjects) byCwd.set(p.cwd, { ...p, sessions: [] });
  for (const s of archived) {
    if (!s.cwd) continue; // store rows always carry cwd; anything else can't be grouped
    let g = byCwd.get(s.cwd);
    if (!g) {
      g = { cwd: s.cwd, sessions: [] };
      byCwd.set(s.cwd, g);
    }
    g.sessions.push(s);
  }
  return [...byCwd.values()].filter((g) => g.sessions.length > 0);
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

  // Project rows in manifest order — shared by the project and archive branches below
  const projects = st.availableProjects
    ? st.availableProjects
    : st.getAvailableProjects
    ? st.getAvailableProjects()
    : st.diskProjects.filter((p) => !new Set(st.removedProjects ?? []).has(p.cwd));

  if (st.viewMode === "project") {
    // 1. Pinned sessions
    const pinnedRows = st.diskProjects
      .flatMap((p) => p.sessions)
      .filter((s) => st.pinnedSessions.has(s.path))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    for (const s of pinnedRows) append(s);

    for (const p of projects) {
      const isExpanded = st.isProjectManageMode || st.expandedProjects.has(p.cwd);
      if (!isExpanded) continue;
      const limit = st.isProjectManageMode ? Infinity : (st.projectLimits.get(p.cwd) ?? 5);
      const visible = p.sessions.slice(0, limit);
      for (const s of visible) append(s);
    }
  } else if (st.viewMode === "archive") {
    // Archive view: grouped by project like the project view — same group order, expand
    // state and row limit rules, so digits follow the grouped top-to-bottom order
    const groups = computeArchiveGroups(st.archivedSessions ?? [], projects);
    for (const g of groups) {
      if (!st.expandedProjects.has(g.cwd)) continue;
      const limit = st.projectLimits.get(g.cwd) ?? 5;
      for (const s of g.sessions.slice(0, limit)) append(s);
    }
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
