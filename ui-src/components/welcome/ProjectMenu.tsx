// Project picker menu (pops upward): search filter + project list + open folder / remote
// connection / work without a project.
// Migrated from ui/welcome.js renderWbProjectList and the initWelcome project menu events;
// conditional-render mounting opens it, the search state resets to empty on mount (matching
// the old searchInput.value="" on open), and the search box focuses after 40ms.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore, send, invoke, getAvailableProjects, setWelcomeProject, pathBase } from "../../store";
import { placeMenu } from "../../shell";
import Icon from "../../Icon";

interface ProjectMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
  onOpenRemote: () => void;
}
export default function ProjectMenu({ anchorRect, onClose, onOpenRemote }: ProjectMenuProps) {

  const { t } = useTranslation();
  const newSessionProject = useAppStore((s) => s.newSessionProject);
  // getAvailableProjects() reads the store live during render: subscribe to its data-source
  // fields (session_list frames land fresh references); this menu re-renders when the project
  // list changes (replacing the old useStore global subscription)
  useAppStore((s) => s.diskProjects);
  useAppStore((s) => s.allProjects);
  useAppStore((s) => s.removedProjects);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    placeMenu(menu, 0, 0);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchorRect.top - rect.height - 4, window.innerHeight - rect.height - 8));
    placeMenu(menu, left, top);
  });

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);

  const available = getAvailableProjects();
  const kw = filter.trim().toLowerCase();
  // Filter: project name or full path contains the keyword (aligned with the old renderWbProjectList)
  const matched = kw
    ? available.filter((p) => {
        const name = pathBase(p.cwd) || p.cwd;
        return name.toLowerCase().includes(kw) || p.cwd.toLowerCase().includes(kw);
      })
    : available;

  // Pick a project: switch data (setWelcomeProject lands it, includes a _v bump) + close the
  // menu (the old item.onclick)
  const choose = (cwd: string) => {
    setWelcomeProject(cwd);
    onClose();
  };

  // Open folder (the old wbProjOpenFolder): Tauri directory dialog → tell the host to register
  // the project → select it as the new project;
  // non-Tauri environments (direct browser debugging) degrade to manually typing an absolute path
  const openFolder = (e: MouseEvent) => {
    e.stopPropagation();
    onClose();
    if (invoke) {
      invoke("plugin:dialog|open", { options: { directory: true, title: t("misc.pickProjectFolder") } })
        .then((p) => {
          if (p) {
            send({ type: "add_project", cwd: p });
            setWelcomeProject(p);
          }
        })
        .catch((err) => {
          console.warn("打开文件夹失败:", err);
        });
    } else {
      const manual = prompt(t("misc.projectPathPrompt"));
      if (manual && manual.trim()) {
        const p = manual.trim();
        send({ type: "add_project", cwd: p });
        setWelcomeProject(p);
      }
    }
  };

  return createPortal((
    <div
      id="wbProjectMenu"
      className="menu wb-project-menu open"
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="wb-proj-search">
        <span className="wb-proj-search-icon flex items-center justify-center text-faint flex-none"><Icon name="search" size={15} /></span>
        <input
          ref={searchRef}
          type="text"
          className="wb-proj-search-input flex-1 border-none bg-transparent outline-none font-sans text-ui-base text-text p-0 min-w-0 placeholder:text-faint"
          id="wbProjSearchInput"
          placeholder={t("misc.searchWorkspaces")}
          autoComplete="off"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (matched[0]) choose(matched[0].cwd); // Enter picks the first match (the old clicking of the list's first item)
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
      </div>
      <div className="wb-proj-list flex-1 max-h-[200px] overflow-y-auto pt-[9px] px-[6px] pb-[5px]" id="wbProjList">
        {matched.length === 0 ? (
          <div className="wb-proj-empty py-[20px] px-[12px] text-center text-faint text-ui-sm">{t("misc.noWorkspaceMatch")}</div>
        ) : (
          matched.map((p) => (
            <div
              key={p.cwd}
              className={"wb-proj-item" + (p.cwd === newSessionProject ? " selected" : "")}
              title={p.remoteLabel ? `${p.remoteLabel}\n${p.cwd}` : p.cwd}
              onClick={(e) => {
                e.stopPropagation();
                choose(p.cwd);
              }}
            >
              <Icon name={p.isDefault ? "comment" : p.remote ? "cloud" : "folderLine"} size={15} className="wb-proj-item-icon flex items-center justify-center text-dim flex-none" />
              <span className="wb-proj-item-name flex-1 truncate">{p.isDefault ? t("misc.defaultProject") : p.remoteLabel || pathBase(p.cwd) || p.cwd}</span>
            </div>
          ))
        )}
      </div>
      <div className="wb-proj-actions">
        <div className="wb-proj-action-item" id="wbProjOpenFolder" title={t("misc.openFolder")} onClick={openFolder}>
          <span className="wb-proj-action-ic flex items-center justify-center text-dim flex-none"><Icon name="folderPlus" size={15} /></span>
          <span className="wb-proj-action-tx flex-1 truncate">{t("misc.openFolder")}</span>
        </div>
        <div
          className="wb-proj-action-item"
          id="wbProjRemote"
          title={t("misc.remoteConn")}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
            onOpenRemote();
          }}
        >
          <span className="wb-proj-action-ic flex items-center justify-center text-dim flex-none"><Icon name="cloud" size={15} /></span>
          <span className="wb-proj-action-tx flex-1 truncate">{t("misc.remoteConn")}</span>
        </div>
        <div
          className="wb-proj-action-item"
          id="wbProjNoProject"
          title={t("misc.noProject")}
          onClick={(e) => {
            e.stopPropagation();
            // The app-owned backing dir is injected as the fixed first project row,
            // so picking it is just choosing that row — no add_project RPC.
            const d = useAppStore.getState().defaultWorkspace;
            if (d) choose(d); // choose() closes the menu itself
            else onClose();
          }}
        >
          <span className="wb-proj-action-ic flex items-center justify-center text-dim flex-none"><Icon name="comment" size={15} /></span>
          <span className="wb-proj-action-tx flex-1 truncate">{t("misc.noProject")}</span>
        </div>
      </div>
    </div>
  ), document.body);
}
