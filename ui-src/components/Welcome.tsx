// 欢迎页（新建任务）：延展卡片 + 项目/分支选择器 + 输入框（Composer 挂进外卡）。
// 迁移自 ui/welcome.js（324 行）。显隐由 App 按 isCreatingNew 分流（替代原版物理搬移 composer）。
// 契约：项目数据 getAvailableProjects()，分支数据 newSessionBranches，问候语按时段。
// 菜单显隐为局部 state：projMenu/branchMenu 存弹出坐标（向上弹出，底边贴胶囊顶边上方 4px，
// 对照原版 offsetLeft / clientHeight-offsetTop 定位写法）；两菜单互斥，
// window click / blur 关闭（对照 shell.js closeAllMenus 的全局关闭语义）。
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useAppStore, toast, pathBase } from "../store";
import Icon from "../Icon";
import Composer from "./Composer";
import ProjectMenu from "./welcome/ProjectMenu";
import BranchMenu from "./welcome/BranchMenu";

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好呀，接下来交给我吧";
  if (h >= 11 && h < 14) return "中午好呀，接下来交给我吧";
  if (h >= 14 && h < 19) return "下午好呀，接下来交给我吧";
  return "晚上好呀，接下来交给我吧";
}

export default function Welcome() {
  // 新建会话三字段（git_branches 帧落地换引用，字段订阅感知）
  const newSessionProject = useAppStore((s) => s.newSessionProject);
  const newSessionIsGit = useAppStore((s) => s.newSessionIsGit);
  const newSessionBranch = useAppStore((s) => s.newSessionBranch);
  // null = 关闭；打开时保存触发按钮的视口坐标，菜单 portal 到 body 后再定位
  const [projMenu, setProjMenu] = useState<DOMRect | null>(null);
  const [branchMenu, setBranchMenu] = useState<DOMRect | null>(null);

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

  // 已开再点 = 关；互斥开另一菜单前先关当前所有（对照原版 closeAllMenus 前置）
  const toggleProjMenu = (e: MouseEvent) => {
    e.stopPropagation();
    if (projMenu) return setProjMenu(null);
    setBranchMenu(null);
    setProjMenu(e.currentTarget.getBoundingClientRect());
  };

  const toggleBranchMenu = (e: MouseEvent) => {
    e.stopPropagation();
    if (branchMenu) return setBranchMenu(null);
    setProjMenu(null);
    setBranchMenu(e.currentTarget.getBoundingClientRect());
  };

  const projName = newSessionProject ? pathBase(newSessionProject) || newSessionProject : "项目";

  return (
    <div id="welcomeScreen" className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-y-auto pt-[30px] px-[20px] pb-[80px]">
      <div className="w-full max-w-[min(720px,100%)] flex flex-col items-center">
        <div className="text-[26px] font-medium text-text mb-[28px] tracking-[0.5px] text-center select-none" /* style-token-ignore */ id="welcomeTitle">{greeting()}</div>
        <div className="wb-wrapper w-full relative flex flex-col" id="wbContainer">
          <div
            id="wbBackCard"
            className="wb-back-card"
          >
            {/* 底部 31px padding 是重叠预算+下顶对称：输入框卡负 margin(-25px)上拉盖住，胶囊到底卡上顶与输入框卡上顶各 7px */}
            <div className="wb-head flex items-center gap-[8px] pt-[6px] px-[6px] pb-[31px]">
              <button
                id="wbProjectBtn"
                className={"wb-pill" + (projMenu ? " active" : "")}
                title={`项目目录: ${newSessionProject}`}
                onClick={toggleProjMenu}
              >
                {/* 项目清除钮：ZCode 同款 hover 替换图标（常态隐藏，hover 胶囊时 folder 淡出、× 淡入） */}
                <span
                  className="wb-proj-clear"
                  id="wbProjClear"
                  title="不在项目中工作"
                  onClick={(e) => {
                    e.stopPropagation();
                    toast("不在项目中工作功能即将推出");
                  }}
                >
                  <Icon name="xmark" size={12} />
                </span>
                <span className={"wb-ic-folder" + (/[\u4e00-\u9fa5]/.test(projName) ? " is-cjk" : "")}><Icon name="folder" size={15} /></span>
                <span id="wbProjectName">{projName}</span>
                <span className="caret caret-svg"><Icon name="caret" /></span>
              </button>
              {newSessionIsGit && (
                <button
                  id="wbBranchBtn"
                  className={"wb-pill" + (branchMenu ? " active" : "")}
                  title={`Git 分支: ${newSessionBranch || "main"}`}
                  onClick={toggleBranchMenu}
                >
                  <Icon name="branch" />
                  <span id="wbBranchName">{newSessionBranch || "main"}</span>
                  <span className="caret caret-svg"><Icon name="caret" /></span>
                </button>
              )}
            </div>
          </div>
          {/* 二级重叠卡（ZCode queue-card ↔ dock 同款几何）：胶囊卡（.wb-back-card）在上，
              输入框卡（#composer.in-welcome）以负 margin 上拉盖其下缘，项目/分支胶囊
              露在胶囊卡上半部分；两卡兄弟位、同宽、边缘对齐。*/}
          <Composer inWelcome={true} />
          {projMenu && <ProjectMenu anchorRect={projMenu} onClose={() => setProjMenu(null)} />}
          {branchMenu && <BranchMenu anchorRect={branchMenu} onClose={() => setBranchMenu(null)} />}
        </div>
      </div>
    </div>
  );
}
