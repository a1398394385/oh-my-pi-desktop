// Projects slice: on-disk project list, pin/expand/limit/unseen marks, the archive area, sidebar
// view mode. Moved over from store.ts (P3 wave 2). Containers switch to "swap reference on change"
// in wave 3 when components move to selectors.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { REMOTE } from "./ws";
import type { DiskProject, DiskSessionRow, RepoGroupFrame, SessionTextSearchFrame } from "../types/frames";

/** One sidebar / welcome-picker project row. Repository-merged rows (worktree merge mode)
 *  carry the display name and every checkout; `cwd` is the primary checkout there. */
export interface AvailableProject {
  cwd: string;
  /** Display name override (repository rows: the repo dir name). */
  name?: string;
  remote?: boolean;
  remoteLabel?: string;
  isDefault?: boolean;
  /** Merged repository row: icon is the worktree one, and the row owns every checkout. */
  isRepoGroup?: boolean;
  worktrees?: RepoGroupFrame["worktrees"];
  sessions: DiskSessionRow[];
}

/** One full-text search hit (session_text_search frame) */
export type SessionTextHit = SessionTextSearchFrame["hits"][number];

export interface ProjectsSlice {
  viewMode: string; // "project" | … (sidebar view)
  isProjectManageMode: boolean;
  allProjects: string[];
  removedProjects: string[];
  /** Project cwds whose working tree has a .git entry (host session_list): gates the row's Git entry. */
  gitProjects: Set<string>;
  /** Repositories merged into one row (host session_list, only when session.worktreeScope is "repo"); empty otherwise. */
  repoGroups: RepoGroupFrame[];
  /** App-owned backing dir for "work without a project" (from the session_list frame). */
  defaultWorkspace: string;
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  diskProjects: DiskProject[];
  /** Full-text search hits (session_text_search frame); query echoes back so the UI can drop a stale frame */
  sessionTextSearch: { query: string; hits: SessionTextHit[] } | null;
  projectLimits: Map<string, number>; // cwd -> rows shown (default 5, step 5)
  expandedProjects: Set<string>;
  pinnedSessions: Set<string>;
  unseenFinished: Set<string>;
  getAvailableProjects(): AvailableProject[];
  /** The merged repository row `cwd` belongs to (undefined when merge mode is off). */
  repoGroupOf(cwd: string): RepoGroupFrame | undefined;
  /** Optimistically stamp the sidebar row's activity time at message send (see impl). */
  bumpSessionActivity(path: string): void;
  saveUnseen(): void;
  expandProject(cwd: string): void;
}

export const createProjectsSlice: StateCreator<AppStore, [], [], ProjectsSlice> = (set, get) => ({
  viewMode: "project",
  isProjectManageMode: false,
  allProjects: [],
  removedProjects: [],
  gitProjects: new Set(),
  repoGroups: [],
  defaultWorkspace: "",
  archivedSessions: [],
  diskProjects: [],
  sessionTextSearch: null,
  projectLimits: new Map(),
  expandedProjects: new Set(),
  pinnedSessions: new Set(),
  unseenFinished: new Set<string>(JSON.parse(localStorage.getItem("omp-unseen-finished") || "[]")),

  // Strictly follow omp-desktop.json allProjects, excluding removed projects; diskProjects not in the list are not merged in
  getAvailableProjects() {
    const st = get();
    const removedSet = new Set(st.removedProjects);
    const byCwd = new Map(st.diskProjects.map((p) => [p.cwd, p]));
    const rowOf = (cwd: string): AvailableProject => {
      const entry = byCwd.get(cwd);
      return {
        cwd,
        // Remote SSH workspace stubs carry their display fields onto the sidebar/welcome rows
        ...(entry?.remote ? { remote: true, remoteLabel: entry.remoteLabel } : {}),
        sessions: entry?.sessions ?? [],
      };
    };
    // Worktree merge mode: the host ships repoGroups only while session.worktreeScope is
    // "repo". Every checkout of a repository then collapses into ONE row (cwd = the primary
    // checkout, so new sessions open there) sitting at the position of its first registered
    // member. Removed members drop out of the merged session list; the row disappears once
    // its primary checkout is removed (host remove_project writes every member cwd).
    const memberOf = new Map<string, RepoGroupFrame>();
    for (const g of st.repoGroups) for (const c of g.cwds) memberOf.set(c, g);
    const groupRow = (g: RepoGroupFrame): AvailableProject => ({
      cwd: g.root,
      name: g.name,
      isRepoGroup: true,
      worktrees: g.worktrees,
      sessions: g.cwds
        .filter((c) => !removedSet.has(c))
        .flatMap((c) => byCwd.get(c)?.sessions ?? [])
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)),
    });
    const rows: AvailableProject[] = [];
    const emitted = new Set<RepoGroupFrame>();
    for (const cwd of st.allProjects) {
      if (removedSet.has(cwd)) continue;
      const g = memberOf.get(cwd);
      if (!g) {
        rows.push(rowOf(cwd));
        continue;
      }
      if (emitted.has(g)) continue;
      emitted.add(g);
      rows.push(groupRow(g));
    }
    // Repository with no registered member (only a linked worktree was ever opened) still
    // gets its row, so its primary checkout stays reachable for new sessions.
    for (const g of st.repoGroups) {
      if (emitted.has(g) || removedSet.has(g.root)) continue;
      rows.push(groupRow(g));
    }
    // The app-owned "work without a project" dir is never in allProjects (the host
    // refuses to register it), so its row is injected here — always first, never
    // removable. Its sessions still arrive through diskProjects keyed by cwd.
    if (st.defaultWorkspace) {
      const entry = byCwd.get(st.defaultWorkspace);
      rows.unshift({ cwd: st.defaultWorkspace, isDefault: true, sessions: entry?.sessions ?? [] });
    }
    return rows;
  },

  // The repository row `cwd` belongs to (session header chip, welcome worktree picker);
  // undefined when merge mode is off or the dir is not a repository checkout.
  repoGroupOf(cwd: string) {
    if (!cwd) return undefined;
    return get().repoGroups.find((g) => g.root === cwd || g.cwds.includes(cwd) || g.worktrees.some((w) => w.path === cwd));
  },

  // Sidebar activity clock = the two user-visible moments only: message send (this bump,
  // optimistic) and run end (the authoritative session_list refresh at runEnd). Match by
  // path, NOT by id: the host pool's sessionId is a per-open random UUID while list rows
  // carry the disk session's own id — the two never coincide. Without the bump, a resumed
  // historical session keeps showing the previous run's end time for the whole loop; bumping
  // per turn_start instead would make the row's time/ordering jitter through a long tool
  // loop. The stamp alone is not enough: inside a project group the row order comes
  // from the host's last list_sessions snapshot (no frontend sort), so a stamped row
  // would render "just now" while sitting below an older one. Re-sort the group by the
  // same descending rule the host applies, so time and position agree until the next
  // authoritative refresh.
  bumpSessionActivity(path: string) {
    const st = get();
    const inProjects = st.diskProjects.some((p) => p.sessions.some((r) => r.path === path));
    const inArchived = st.archivedSessions.some((r) => r.path === path);
    if (!inProjects && !inArchived) return; // not listed yet (fresh session): the session_created list refresh carries it
    const iso = new Date().toISOString();
    set({
      diskProjects: st.diskProjects.map((p) => {
        if (!p.sessions.some((r) => r.path === path)) return p;
        return {
          ...p,
          sessions: p.sessions
            .map((r) => (r.path === path ? { ...r, modified: iso } : r))
            .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified)),
        };
      }),
      archivedSessions: inArchived
        ? st.archivedSessions
            .map((r) => (r.path === path ? { ...r, modified: iso } : r))
            .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
        : st.archivedSessions,
    });
  },

  saveUnseen() {
    localStorage.setItem("omp-unseen-finished", JSON.stringify([...get().unseenFinished].slice(-200)));
  },

  expandProject(cwd: string) {
    if (!cwd) return;
    const st = get();
    if (st.expandedProjects.has(cwd)) return; // already expanded, nothing to do
    const nextExpanded = new Set(st.expandedProjects);
    nextExpanded.add(cwd);
    const nextLimits = new Map(st.projectLimits);
    nextLimits.delete(cwd);
    if (!REMOTE) get().send({ type: "set_project_expanded", cwd, expanded: true }); // persisted in host omp-desktop.json; remote stays read-only
    set({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  },
});
