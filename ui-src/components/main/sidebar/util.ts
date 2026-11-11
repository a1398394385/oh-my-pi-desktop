// Sidebar utilities (ported from ui/sidebar.js): relative time formatting /
// session label / clipboard copy.
// fmtAgo is the single shared definition (consumed by tree/SessionTreeStream);
// fmtDuration lives in chat/util.ts.
import { useEffect, useRef, useState } from "react";
import { atMentions } from "../../../lib/at-mentions";
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
  // The first message carries the @path lines a path attachment appended; they are chips in
  // the transcript, not part of what the user said.
  const first = s.firstMessage === "(no messages)" ? "" : atMentions(s.firstMessage ?? "").text;
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
    try {
      document.execCommand("copy");
    } catch {
      // Leave the failure to the caller's toast; a copy button must never throw.
    }
    ta.remove();
  };
  if (!navigator.clipboard?.writeText) {
    execFallback();
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(text).catch(() => execFallback());
}

// Button success flash without a toast: the button swaps its icon/label for this long, then
// reverts. One window for every success-shaped button (copy, fork) so the rhythm stays uniform.
export const SUCCESS_FLASH_MS = 800;

export function useSuccessFlash() {
  const [flashed, setFlashed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    window.clearTimeout(timer.current);
    setFlashed(true);
    timer.current = window.setTimeout(() => setFlashed(false), SUCCESS_FLASH_MS);
  };
  return { flashed, flash };
}

// Copy feedback: writes the clipboard, then flashes the button. Rejection is left to the caller,
// which keeps its failure toast.
export function useCopyFeedback() {
  const { flashed, flash } = useSuccessFlash();
  const copy = (text: string) => copyText(text).then(flash);
  return { copied: flashed, copy };
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

/** Extra width granted to the sidebar while ⌘ is held (titles get cut off at the
 * stored width otherwise) */
export const HELD_SIDEBAR_EXTRA = 140;

/**
 * Sidebar width while ⌘ is held: current + HELD_SIDEBAR_EXTRA, capped by the same
 * center-card floor the resize handle enforces (30% of the window, at least 240px).
 * Returns `cur` unchanged when the window is too narrow to give the sidebar more room.
 */
export function computeHeldSidebarWidth(cur: number, rightW: number, winW: number): number {
  const minMainW = Math.max(240, Math.floor(winW * 0.3));
  return Math.round(Math.min(cur + HELD_SIDEBAR_EXTRA, Math.max(cur, winW - minMainW - rightW - 32)));
}

export interface ShortcutExpansionState {
  availableProjects: { cwd: string; sessions: ShortcutSessionCandidate[] }[];
  expandedProjects: Set<string>;
  projectLimits: Map<string, number>;
  openSessions: Map<string, { streaming?: boolean; items?: { role: string; running?: boolean }[] }>;
  unseenFinished: Set<string>;
}

/**
 * Projects to transiently expand while ⌘ is held: the ones whose rows receive a
 * ⌘1~9 badge (running first, unread fills the rest, at most 9 — same priority and
 * project row-limit rule as computeSidebarSessionShortcuts). A collapsed project
 * hides its badge rows, unread ones included.
 */
export function computeShortcutProjects(st: ShortcutExpansionState): string[] {
  const running: string[] = [];
  const unread: string[] = [];
  for (const p of st.availableProjects) {
    const limit = st.projectLimits.get(p.cwd) ?? 5;
    for (const s of p.sessions.slice(0, limit)) {
      if (isSessionRunning(st.openSessions.get(s.path))) running.push(p.cwd);
      else if (st.unseenFinished.has(s.path)) unread.push(p.cwd);
    }
  }
  // shortcut: pinned sessions are ordered first by computeSidebarSessionShortcuts, here
  // they follow their project row — only shifts which projects expand when >9 sessions
  // compete, upgrade if badge/project mismatch shows up.
  const chosen =
    running.length >= SHORTCUT_DIGITS.length
      ? running.slice(0, SHORTCUT_DIGITS.length)
      : [...running, ...unread.slice(0, SHORTCUT_DIGITS.length - running.length)];
  // Already-expanded projects consumed digits above but are not auto-expanded.
  return [...new Set(chosen)].filter((cwd) => !st.expandedProjects.has(cwd));
}
