// 项目列表 slice：磁盘项目列表、置顶/展开/限额/未读标记、归档区、侧栏视图模式。
// 自 store.ts 平移（P3 波 2）。容器在波 3 组件切 selector 时改为「变更换引用」。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import type { DiskProject, DiskSessionRow } from "../types/frames";

export interface ProjectsSlice {
  viewMode: string; // "project" | …（侧栏视图）
  isProjectManageMode: boolean;
  allProjects: string[];
  removedProjects: string[];
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  diskProjects: DiskProject[];
  projectLimits: Map<string, number>; // cwd -> 已显示条数（默认 5，步进 5）
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

  // 顺序 = omp-desktop.json allProjects 的手工/自动发现顺序；磁盘上兜底并入的新项目按磁盘序缀尾
  getAvailableProjects() {
    const st = get();
    const removedSet = new Set(st.removedProjects);
    const sessionsOf = new Map(st.diskProjects.map((p) => [p.cwd, p.sessions]));
    const known = [...new Set([...st.allProjects, ...st.diskProjects.map((p) => p.cwd)])];
    return known
      .filter((cwd) => !removedSet.has(cwd))
      .map((cwd) => ({ cwd, sessions: sessionsOf.get(cwd) ?? [] }));
  },

  saveUnseen() {
    localStorage.setItem("omp-unseen-finished", JSON.stringify([...get().unseenFinished].slice(-200)));
  },

  expandProject(cwd: string) {
    if (!cwd) return;
    const st = get();
    if (st.expandedProjects.has(cwd)) return; // 已处于展开态，不用动
    const nextExpanded = new Set(st.expandedProjects);
    nextExpanded.add(cwd);
    const nextLimits = new Map(st.projectLimits);
    nextLimits.delete(cwd);
    get().send({ type: "set_project_expanded", cwd, expanded: true });
    set({ expandedProjects: nextExpanded, projectLimits: nextLimits });
  },
});
