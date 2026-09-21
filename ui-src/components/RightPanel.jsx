// 右栏：logo 工具条 + tab 栏（子代理/Git Diff/文件/后台命令/分支）+ 面板体。
// 迁移自 ui/right.js。tab 开关列表为模块级 rightTabs（有序），激活项 S.rightTab；
// tab 管理在 ./right/tabs.js（各页面共用），此处 re-export 保持既有导出面。
// 契约：数据读 S/rightState/gitDiffCache/fileDiffCache/openSessions，动作后 notify()；
// 三个详情页（gitdiff 文件/文件视图/子代理）沿用定稿骨架：#rightBody 加 detail 类，
// rb-head 固定 + rb-scroll 滚动（style.css #rightBody.detail 规则）。
import { S, useStore, notify, activeOpen, gitDiffCache, refreshGitDiff } from "../store.js";
import Icon from "../Icon.jsx";
import { TAB_META, rightTabs, closeRightTab } from "./right/tabs.js";
import StartPage from "./right/StartPage.jsx";
import SubagentPage from "./right/SubagentPage.jsx";
import GitDiffPage from "./right/GitDiffPage.jsx";
import FilePage from "./right/FilePage.jsx";
import BgCmdPage from "./right/BgCmdPage.jsx";
import BranchTreePage from "./right/BranchTreePage.jsx";

// 兼容既有导出面（tab 管理实现已拆至 right/tabs.js）
export { TAB_META, rightTabs, openRightTab, closeRightTab } from "./right/tabs.js";

export default function RightPanel({ collapsed }) {
  useStore();
  const s = activeOpen();
  // 非 git 会话不保留 Git Diff tab（打开的列表与激活项都回落）
  if (!s?.isGit && rightTabs.includes("gitdiff")) {
    const i = rightTabs.indexOf("gitdiff");
    rightTabs.splice(i, 1);
    if (S.rightTab === "gitdiff") S.rightTab = rightTabs[Math.min(i, rightTabs.length - 1)] ?? null;
  }
  const isGitTab = S.rightTab === "gitdiff";
  // 详情模式（原 renderRightBody 各详情分支对 #rightBody 加 .detail；判定顺序对齐原版：
  // gitdiff 先过 !s/!isGit 兜底，故非 git 时 selectedFile 不进详情）
  const detail =
    (S.rightTab === "gitdiff" && !!s?.isGit && !!S.selectedFile) ||
    (S.rightTab === "file" && !!S.fileView) ||
    (S.rightTab === "subagent" && !!S.selectedSubagent && !!s?.subagents?.has(S.selectedSubagent));
  let body;
  if (S.rightTab === null) body = <StartPage />; // tab 全部关闭：居中起始页
  else if (S.rightTab === "gitdiff") body = <GitDiffPage />;
  else if (S.rightTab === "bgcmd") body = <BgCmdPage />;
  else if (S.rightTab === "file") body = <FilePage />;
  else if (S.rightTab === "tree") body = <BranchTreePage />;
  else body = <SubagentPage />;
  return (
    <aside id="right" className={collapsed ? "collapsed" : ""}>
      <div className="rtoolbar" data-tauri-drag-region="">
        <button className="icon-btn logo" title="当前 project">
          <Icon name="logo" />
          <span id="wsName" style={{ fontSize: "var(--ui-fs-xs)", color: "var(--dim)" }}>
            {s ? s.cwd.split("/").filter(Boolean).pop() : "—"}
          </span>
        </button>
      </div>
      <div id="sidepanel">
        <div className="sp-head">
          <div className="rtabs" id="rightTabs">
            {rightTabs.map((name) => (
              <button key={name} className={"rtab" + (S.rightTab === name ? " on" : "")} onClick={() => { S.rightTab = name; notify(); }}>
                <span className="rtab-ic"><Icon name={TAB_META[name].icon} /></span>
                <span className="rtab-tx">{TAB_META[name].label}</span>
                <span className="rtab-x" onClick={(e) => { e.stopPropagation(); closeRightTab(name); }}>
                  <Icon name="xmark" size={10} />
                </span>
              </button>
            ))}
          </div>
          <span className="sp"></span>
          {isGitTab && (
            <button
              className="icon-btn"
              id="gitRefresh"
              title="刷新"
              onClick={(e) => {
                e.stopPropagation();
                const cur = activeOpen();
                if (!cur || !cur.isGit) return;
                gitDiffCache.cwd = null; // 强制重拉
                refreshGitDiff();
                notify();
              }}
            >
              <Icon name="refresh" />
            </button>
          )}
          {isGitTab && (
            <button
              className="icon-btn"
              id="gitViewToggle"
              title="切换树/平铺"
              onClick={(e) => {
                e.stopPropagation();
                S.gitViewMode = S.gitViewMode === "tree" ? "flat" : "tree";
                notify();
              }}
            >
              {S.gitViewMode === "tree" ? "树" : "平铺"}
            </button>
          )}
        </div>
        <div id="rightBody" className={detail ? "detail" : ""}>
          {body}
        </div>
      </div>
    </aside>
  );
}
