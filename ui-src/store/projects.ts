// Projects slice: on-disk project list, pin/expand/limit/unseen marks, the archive area, sidebar
// view mode. Moved over from store.ts (P3 wave 2). Containers switch to "swap reference on change"
// in wave 3 when components move to selectors.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { DiskProject, DiskSessionRow } from "../types/frames";

export interface ProjectsSlice {
  viewMode: string; // "project" | … (sidebar view)
  isProjectManageMode: boolean;
  allProjects: string[];
  removedProjects: string[];
  /** App-owned backing dir for "work without a project" (from the session_list frame). */
  defaultWorkspace: string;
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  diskProjects: DiskProject[];
  projectLimits: Map<string, number>; // cwd -> rows shown (default 5, step 5)
  expandedProjects: Set<string>;
  pinnedSessions: Set<string>;
  unseenFinished: Set<string>;
  getAvailableProjects(): { cwd: string; remote?: boolean; remoteLabel?: string; sessions: DiskSessionRow[]; isDefault?: boolean }[];
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
  defaultWorkspace: "",
  archivedSessions: [],
  diskProjects: [],
  projectLimits: new Map(),
  expandedProjects: new Set(),
  pinnedSessions: new Set(),
  unseenFinished: new Set<string>(JSON.parse(localStorage.getItem("omp-unseen-finished") || "[]")),

  // Strictly follow omp-desktop.json allProjects, excluding removed projects; diskProjects not in the list are not merged in
  getAvailableProjects() {
    const st = get();
    const removedSet = new Set(st.removedProjects);
    const byCwd = new Map(st.diskProjects.map((p) => [p.cwd, p]));
    const rows: { cwd: string; remote?: boolean; remoteLabel?: string; isDefault?: boolean; sessions: DiskSessionRow[] }[] = st.allProjects
      .filter((cwd) => !removedSet.has(cwd))
      .map((cwd) => {
        const entry = byCwd.get(cwd);
        return {
          cwd,
          // Remote SSH workspace stubs carry their display fields onto the sidebar/welcome rows
          ...(entry?.remote ? { remote: true, remoteLabel: entry.remoteLabel } : {}),
          sessions: entry?.sessions ?? [],
        };
      });
    // The app-owned "work without a project" dir is never in allProjects (the host
    // refuses to register it), so its row is injected here — always first, never
    // removable. Its sessions still arrive through diskProjects keyed by cwd.
    if (st.defaultWorkspace) {
      const entry = byCwd.get(st.defaultWorkspace);
      rows.unshift({ cwd: st.defaultWorkspace, isDefault: true, sessions: entry?.sessions ?? [] });
    }
    return rows;
  },

  // Sidebar activity clock = the two user-visible moments only: message send (this bump,
  // optimistic) and run end (the authoritative session_list refresh at runEnd). Match by
  // path, NOT by id: the host pool's sessionId is a per-open random UUID while list rows
  // carry the disk session's own id — the two never coincide. Without the bump, a resumed
  // historical session keeps showing the previous run's end time for the whole loop; bumping
  // per turn_start instead would make the row's time/ordering jitter through a long tool
  // loop. Only the timestamp is swapped — row order stays with the host list.
  bumpSessionActivity(path: string) {
    const st = get();
    const inProjects = st.diskProjects.some((p) => p.sessions.some((r) => r.path === path));
    const inArchived = st.archivedSessions.some((r) => r.path === path);
    if (!inProjects && !inArchived) return; // not listed yet (fresh session): the session_created list refresh carries it
    const iso = new Date().toISOString();
    set({
      diskProjects: st.diskProjects.map((p) =>
        p.sessions.some((r) => r.path === path)
          ? { ...p, sessions: p.sessions.map((r) => (r.path === path ? { ...r, modified: iso } : r)) }
          : p,
      ),
      archivedSessions: inArchived ? st.archivedSessions.map((r) => (r.path === path ? { ...r, modified: iso } : r)) : st.archivedSessions,
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
    get().send({ type: "set_project_expanded", cwd, expanded: true });
    set({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  },
});
