// 项目选择菜单（向上弹出）：搜索过滤 + 项目列表 + 打开文件夹/远程连接/不在项目中工作。
// 迁移自 ui/welcome.js renderWbProjectList 与 initWelcome 项目菜单事件；条件渲染挂载即打开，
// 搜索态随挂载重置为空（对应原版打开时 searchInput.value=""），40ms 后聚焦搜索框。
import { useEffect, useRef, useState } from "react";
import { useAppStore, send, toast, invoke, getAvailableProjects, setWelcomeProject } from "../../store";
import Icon from "../../Icon.jsx";

export default function ProjectMenu({ pos, onClose }) {
  const newSessionProject = useAppStore((s) => s.newSessionProject);
  // getAvailableProjects() 渲染期读 store 实时值：订阅其数据源字段（session_list 帧落地换引用），
  // 项目列表变化时本菜单重渲染（替代旧 useStore 全局订阅）
  useAppStore((s) => s.diskProjects);
  useAppStore((s) => s.allProjects);
  useAppStore((s) => s.removedProjects);
  const [filter, setFilter] = useState("");
  const searchRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);

  const available = getAvailableProjects();
  const kw = filter.trim().toLowerCase();
  // 过滤：项目名或完整路径包含关键字（对照原版 renderWbProjectList）
  const matched = kw
    ? available.filter((p) => {
        const name = p.cwd.split("/").filter(Boolean).pop() || p.cwd;
        return name.toLowerCase().includes(kw) || p.cwd.toLowerCase().includes(kw);
      })
    : available;

  // 选中项目：切数据（setWelcomeProject 落地，内含 _v bump）+ 关菜单（原版 item.onclick）
  const choose = (cwd) => {
    setWelcomeProject(cwd);
    onClose();
  };

  // 打开文件夹（原版 wbProjOpenFolder）：Tauri 目录对话框 → 通知宿主登记项目 → 选为新项目；
  // 非 Tauri 环境（浏览器直连调试）退化为手输绝对路径
  const openFolder = (e) => {
    e.stopPropagation();
    onClose();
    if (invoke) {
      invoke("plugin:dialog|open", { options: { directory: true, title: "选择项目文件夹" } })
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
      const manual = prompt("请输入项目文件夹绝对路径：");
      if (manual && manual.trim()) {
        const p = manual.trim();
        send({ type: "add_project", cwd: p });
        setWelcomeProject(p);
      }
    }
  };

  return (
    <div
      id="wbProjectMenu"
      className="menu wb-project-menu open"
      style={{ left: pos.left + "px", bottom: pos.bottom + "px", top: "auto" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="wb-proj-search">
        <span className="wb-proj-search-icon"><Icon name="search" size={13} /></span>
        <input
          ref={searchRef}
          type="text"
          className="wb-proj-search-input"
          id="wbProjSearchInput"
          placeholder="搜索工作区"
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
      <div className="wb-proj-list" id="wbProjList">
        {matched.length === 0 ? (
          <div className="wb-proj-empty">无匹配工作区</div>
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
              <Icon name="folderLine" size={14} className="wb-proj-item-icon" />
              <span className="wb-proj-item-name">{p.cwd.split("/").filter(Boolean).pop() || p.cwd}</span>
            </div>
          ))
        )}
      </div>
      <div className="wb-proj-actions">
        <div className="wb-proj-action-item" id="wbProjOpenFolder" title="打开文件夹" onClick={openFolder}>
          <span className="wb-proj-action-ic"><Icon name="folderPlus" size={14} /></span>
          <span className="wb-proj-action-tx">打开文件夹</span>
        </div>
        <div
          className="wb-proj-action-item"
          id="wbProjRemote"
          title="远程连接"
          onClick={(e) => {
            e.stopPropagation();
            toast("远程连接功能即将推出");
            onClose();
          }}
        >
          <span className="wb-proj-action-ic"><Icon name="cloud" size={14} /></span>
          <span className="wb-proj-action-tx">远程连接</span>
        </div>
        <div
          className="wb-proj-action-item"
          id="wbProjNoProject"
          title="不在项目中工作"
          onClick={(e) => {
            e.stopPropagation();
            toast("不在项目中工作功能即将推出");
            onClose();
          }}
        >
          <span className="wb-proj-action-ic"><Icon name="comment" size={14} /></span>
          <span className="wb-proj-action-tx">不在项目中工作</span>
        </div>
      </div>
    </div>
  );
}
