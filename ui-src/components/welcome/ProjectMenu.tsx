// 项目选择菜单（向上弹出）：搜索过滤 + 项目列表 + 打开文件夹/远程连接/不在项目中工作。
// 迁移自 ui/welcome.js renderWbProjectList 与 initWelcome 项目菜单事件；条件渲染挂载即打开，
// 搜索态随挂载重置为空（对应原版打开时 searchInput.value=""），40ms 后聚焦搜索框。
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, invoke, getAvailableProjects, setWelcomeProject, pathBase } from "../../store";
import { placeMenu } from "../../shell";
import Icon from "../../Icon";

interface ProjectMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export default function ProjectMenu({ anchorRect, onClose }: ProjectMenuProps) {
  const { t } = useTranslation();
  const newSessionProject = useAppStore((s) => s.newSessionProject);
  // getAvailableProjects() 渲染期读 store 实时值：订阅其数据源字段（session_list 帧落地换引用），
  // 项目列表变化时本菜单重渲染（替代旧 useStore 全局订阅）
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
  // 过滤：项目名或完整路径包含关键字（对照原版 renderWbProjectList）
  const matched = kw
    ? available.filter((p) => {
        const name = pathBase(p.cwd) || p.cwd;
        return name.toLowerCase().includes(kw) || p.cwd.toLowerCase().includes(kw);
      })
    : available;

  // 选中项目：切数据（setWelcomeProject 落地，内含 _v bump）+ 关菜单（原版 item.onclick）
  const choose = (cwd: string) => {
    setWelcomeProject(cwd);
    onClose();
  };

  // 打开文件夹（原版 wbProjOpenFolder）：Tauri 目录对话框 → 通知宿主登记项目 → 选为新项目；
  // 非 Tauri 环境（浏览器直连调试）退化为手输绝对路径
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
              if (matched[0]) choose(matched[0].cwd); // Enter 选首个匹配（原版点击列表第一项）
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
              title={p.cwd}
              onClick={(e) => {
                e.stopPropagation();
                choose(p.cwd);
              }}
            >
              <Icon name="folderLine" size={15} className="wb-proj-item-icon flex items-center justify-center text-dim flex-none" />
              <span className="wb-proj-item-name flex-1 truncate">{pathBase(p.cwd) || p.cwd}</span>
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
            toast(t("misc.remoteConnSoon"));
            onClose();
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
            toast(t("misc.noProjectSoon"));
            onClose();
          }}
        >
          <span className="wb-proj-action-ic flex items-center justify-center text-dim flex-none"><Icon name="comment" size={15} /></span>
          <span className="wb-proj-action-tx flex-1 truncate">{t("misc.noProject")}</span>
        </div>
      </div>
    </div>
  ), document.body);
}
