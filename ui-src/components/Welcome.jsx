// 欢迎页（新建任务）：延展卡片 + 项目/分支选择器 + 输入框（Composer 挂进外卡）。
// 迁移自 ui/welcome.js（324 行）。显隐由 App 按 S.isCreatingNew 分流（替代原版物理搬移 composer）。
// 契约：项目数据 getAvailableProjects()，分支数据 S.newSessionBranches，问候语按时段。
// 菜单显隐为局部 state：projMenu/branchMenu 存弹出坐标（向上弹出，底边贴胶囊顶边上方 4px，
// 对照原版 offsetLeft / clientHeight-offsetTop 定位写法）；两菜单互斥，
// window click / blur 关闭（对照 shell.js closeAllMenus 的全局关闭语义）。
import { useEffect, useRef, useState } from "react";
import { S, useStore, toast } from "../store.js";
import Icon from "../Icon.jsx";
import Composer from "./Composer.jsx";
import ProjectMenu from "./welcome/ProjectMenu.jsx";
import BranchMenu from "./welcome/BranchMenu.jsx";

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好呀，接下来交给我吧";
  if (h >= 11 && h < 14) return "中午好呀，接下来交给我吧";
  if (h >= 14 && h < 19) return "下午好呀，接下来交给我吧";
  return "晚上好呀，接下来交给我吧";
}

export default function Welcome() {
  useStore();
  // null = 关闭；{left, bottom} = 打开坐标（px，相对 .wb-back-card）
  const [projMenu, setProjMenu] = useState(null);
  const [branchMenu, setBranchMenu] = useState(null);
  const backCardRef = useRef(null);
  const projBtnRef = useRef(null);
  const branchBtnRef = useRef(null);

  const menuOpen = !!projMenu || !!branchMenu;

  // 全局关闭：点击菜单外任意处 / 窗口失焦（打开动作与菜单内点击均已 stopPropagation，不会误关）
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setProjMenu(null);
      setBranchMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  // 向上弹出坐标：菜单左缘对齐胶囊，底边贴胶囊顶边上方 4px（对照原版 welcome.js 定位写法）
  const popPos = (btn) => {
    const card = backCardRef.current;
    return { left: btn.offsetLeft, bottom: card.clientHeight - btn.offsetTop + 4 };
  };

  // 已开再点 = 关；互斥开另一菜单前先关当前所有（对照原版 closeAllMenus 前置）
  const toggleProjMenu = (e) => {
    e.stopPropagation();
    if (projMenu) return setProjMenu(null);
    setBranchMenu(null);
    setProjMenu(popPos(projBtnRef.current));
  };

  const toggleBranchMenu = (e) => {
    e.stopPropagation();
    if (branchMenu) return setBranchMenu(null);
    setProjMenu(null);
    setBranchMenu(popPos(branchBtnRef.current));
  };

  const projName = S.newSessionProject
    ? S.newSessionProject.split("/").filter(Boolean).pop() || S.newSessionProject
    : "项目";

  return (
    <div id="welcomeScreen" className="welcome-screen">
      <div className="welcome-card">
        <div className="welcome-title" id="welcomeTitle">{greeting()}</div>
        <div className="wb-wrapper" id="wbContainer">
          <div
            ref={backCardRef}
            id="wbBackCard"
            className={"wb-back-card" + (menuOpen ? " menu-open" : "")}
          >
            <div className="wb-head">
              <button
                ref={projBtnRef}
                id="wbProjectBtn"
                className={"wb-pill" + (projMenu ? " active" : "")}
                title={`项目目录: ${S.newSessionProject}`}
                onClick={toggleProjMenu}
              >
                {/* 项目清除钮：独立于菜单的提示入口（stopPropagation 防止触发菜单开关） */}
                <span
                  className="wb-proj-clear"
                  id="wbProjClear"
                  title="不在项目中工作"
                  onClick={(e) => {
                    e.stopPropagation();
                    toast("不在项目中工作功能即将推出");
                  }}
                >
                  <Icon name="xmark" size={11} />
                </span>
                <span id="wbProjectName">{projName}</span>
                <span className="caret caret-svg"><Icon name="caret" /></span>
              </button>
              {S.newSessionIsGit && (
                <button
                  ref={branchBtnRef}
                  id="wbBranchBtn"
                  className={"wb-pill" + (branchMenu ? " active" : "")}
                  title={`Git 分支: ${S.newSessionBranch || "main"}`}
                  onClick={toggleBranchMenu}
                >
                  <Icon name="branch" />
                  <span id="wbBranchName">{S.newSessionBranch || "main"}</span>
                  <span className="caret caret-svg"><Icon name="caret" /></span>
                </button>
              )}
            </div>
            {projMenu && <ProjectMenu pos={projMenu} onClose={() => setProjMenu(null)} />}
            {branchMenu && <BranchMenu pos={branchMenu} onClose={() => setBranchMenu(null)} />}
          </div>
          <Composer inWelcome={true} />
        </div>
      </div>
    </div>
  );
}
