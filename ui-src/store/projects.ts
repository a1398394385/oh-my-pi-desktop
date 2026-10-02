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
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  diskProjects: DiskProject[];
  projectLimits: Map<string, number>; // cwd -> rows shown (default 5, step 5)
  expandedProjects: Set<string>;
  pinnedSessions: Set<string>;
  unseenFinished: Set<string>;
  getAvailableProjects(): { cwd: string; sessions: DiskSessionRow[] }[];
  saveUnseen(): void;
  expandProject(cwd: string): void;
}

export const createProjectsSlice: StateCreator<AppStore, [], [], ProjectsSlice> = (set, get) => ({
  viewMode: "project",
  isProjectManageMode: false,
  allProjects: [],
  removedProjects: [],
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
    const sessionsOf = new Map(st.diskProjects.map((p) => [p.cwd, p.sessions]));
    return st.allProjects
      .filter((cwd) => !removedSet.has(cwd))
      .map((cwd) => ({ cwd, sessions: sessionsOf.get(cwd) ?? [] }));
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
