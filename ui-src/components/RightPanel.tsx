// 右栏：tab 头在最顶端（ZCode Side Pane 风格：左总览 popover / 中等宽可拖拽 tab / 右新增）
// + 面板体。迁移自 ui/right.js（原顶部 logo 工具条已删，tab 栏置顶）。tab 开关列表与激活项在
// store（rightTabs 有序 / rightTab），本组件经 selector 订阅；tab 管理在 ./right/tabs.js
// （各页面共用），此处 re-export 保持既有导出面。
// 契约：数据经 useAppStore selector 订阅（当前会话 / rightTab / selectedFile 等），
// 写走 setBump 与既有函数；三个详情页（gitdiff 文件/文件视图/子代理）沿用定稿骨架：
// #rightBody 加 detail 类，rb-head 固定 + rb-scroll 滚动（style.css #rightBody.detail 规则）。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useAppStore, setBump, activeOpen, refreshGitDiff } from "../store";
import Icon from "../Icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  TAB_META,
  openRightTab, closeRightTab, reopenRightTab, moveRightTab,
} from "./right/tabs";
import StartPage from "./right/StartPage";
import SubagentPage from "./right/SubagentPage";
import GitDiffPage from "./right/GitDiffPage";
import FilePage from "./right/FilePage";
import BgCmdPage from "./right/BgCmdPage";
import BranchTreePage from "./right/BranchTreePage";
import SessionTreePage from "./right/SessionTreePage";
import TerminalPage from "./right/TerminalPage";
import BrowserPage from "./right/BrowserPage";

// 兼容既有导出面（tab 管理实现已拆至 right/tabs.js）
export { TAB_META, openRightTab, closeRightTab } from "./right/tabs";

// tab 头 hover 提示：原生 title 换 Radix Tooltip（浮层卡视觉走 ui/tooltip 基件）。
// children 必须是可挂 ref 的 DOM 元素（Radix Trigger 经 asChild 注入 ref 定位锚点）
function Tip({ label, children }: { label?: string; children: ReactElement }) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

// 「最近关闭」相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前
function closedAgo(at: number): string {
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// tab 总览 popover：搜索框 + 打开中（点击切换 / 逐项关闭）+ 最近关闭（点击重开）。
// 复用 .menu 弹层视觉；坐标走 sp-head 相对定位（absolute 随面板 zoom 缩放不错位）。
function TabOverview({ onClose }: { onClose: () => void }) {
  const rightTabs = useAppStore((st) => st.rightTabs);
  const rightRecentClosed = useAppStore((st) => st.rightRecentClosed);
  const rightTab = useAppStore((st) => st.rightTab);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const kw = q.trim().toLowerCase();
  const match = (name: string) => !kw || TAB_META[name].label.toLowerCase().includes(kw);
  const opens = rightTabs.filter(match);
  const recents = rightRecentClosed.filter((x) => match(x.name));
  return (
    <div className="menu open sp-pop" onClick={(e) => e.stopPropagation()}>
      <div className="sp-pop-search">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          placeholder="搜索标签页"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="sp-pop-scroll">
        <div className="mh">打开中</div>
        {opens.length === 0 && <div className="mi empty">无匹配的标签页</div>}
        {opens.map((name) => (
          <div
            key={name}
            className={"mi" + (rightTab === name ? " on" : "")}
            onClick={() => { setBump({ rightTab: name }); onClose(); }}
          >
            <span className="mi-ic"><Icon name={TAB_META[name].icon} size={14} /></span>
            {TAB_META[name].label}
            <Tip label="关闭">
              <span
                className="mi-x"
                onClick={(e) => { e.stopPropagation(); closeRightTab(name); if (!useAppStore.getState().rightTabs.length) onClose(); }}
              >
                <Icon name="xmark" size={11} />
              </span>
            </Tip>
          </div>
        ))}
        {recents.length > 0 && <div className="mh">最近关闭</div>}
        {recents.map((x) => (
          <div key={x.name} className="mi" onClick={() => { reopenRightTab(x.name); onClose(); }}>
            <span className="mi-ic"><Icon name={TAB_META[x.name].icon} size={14} /></span>
            {TAB_META[x.name].label}
            <span className="sub">{closedAgo(x.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 「新增」菜单：列出全部可开 tab（已开的打勾，git 限定项非 git 仓库置灰）
function AddTabMenu({ isGit, onClose }: { isGit: boolean; onClose: () => void }) {
  const rightTabs = useAppStore((st) => st.rightTabs);
  return (
    <div className="menu open sp-pop sp-add" onClick={(e) => e.stopPropagation()}>
      <div className="sp-pop-scroll">
        {Object.keys(TAB_META).map((name) => {
          const off = name === "gitdiff" && !isGit;
          const on = rightTabs.includes(name);
          return (
            <Tip key={name} label={off ? "当前项目不是 git 仓库" : undefined}>
              <div
                className={"mi" + (off ? " empty" : "")}
                onClick={off ? undefined : () => { openRightTab(name); onClose(); }}
              >
                <span className="ck">{on ? "✓" : ""}</span>
                <span className="mi-ic"><Icon name={TAB_META[name].icon} size={14} /></span>
                {TAB_META[name].label}
              </div>
            </Tip>
          );
        })}
      </div>
    </div>
  );
}

// 单个 tab：等宽 flex、原生 drag 重排、hover 才出现的关闭钮、中键关闭
function TabButton({ name, on }: { name: string; on: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <button
      className={"rtab" + (on ? " on" : "") + (over ? " drag-over" : "")}
      draggable
      onClick={() => { setBump({ rightTab: name }); }}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("text/plain")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const src = e.dataTransfer.getData("text/plain");
        if (src && src !== name) moveRightTab(src, name);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeRightTab(name);
        }
      }}
    >
      <span className="rtab-ic"><Icon name={TAB_META[name].icon} size={13} /></span>
      <span className="rtab-tx">{TAB_META[name].label}</span>
      <Tip label="关闭">
        <span
          className="rtab-x"
          onClick={(e) => { e.stopPropagation(); closeRightTab(name); }}
        >
          <Icon name="xmark" size={10} />
        </span>
      </Tip>
    </button>
  );
}

export default function RightPanel({ collapsed }: { collapsed?: boolean }) {
  // 当前会话 + 右栏散字段全部字段订阅（openRightTab 等不 bump _v，靠字段订阅驱动重渲染）
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightTabs = useAppStore((st) => st.rightTabs); // tab 列表入 store：字段订阅驱动重渲染
  const rightTab = useAppStore((st) => st.rightTab);
  const selectedFile = useAppStore((st) => st.selectedFile);
  const fileView = useAppStore((st) => st.fileView);
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  const gitViewMode = useAppStore((st) => st.gitViewMode);
  const [ovOpen, setOvOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // 弹层关闭统一走 omp:close-menus（window click/blur → closeAllMenus 平移），
  // 触发钮自身 stopPropagation 故不受全局关闭影响
  useEffect(() => {
    const close = () => { setOvOpen(false); setAddOpen(false); };
    document.addEventListener("omp:close-menus", close);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("omp:close-menus", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  // 非 git 会话不保留 Git Diff tab（打开的列表与激活项都回落）
  let tabs = rightTabs;
  if (!s?.isGit && tabs.includes("gitdiff")) {
    const i = tabs.indexOf("gitdiff");
    tabs = tabs.filter((n) => n !== "gitdiff");
    const st = useAppStore.getState();
    useAppStore.setState({
      rightTabs: tabs,
      rightTab: st.rightTab === "gitdiff" ? tabs[Math.min(i, tabs.length - 1)] ?? null : st.rightTab,
    });
  }
  const isGitTab = rightTab === "gitdiff";
  // 详情模式（原 renderRightBody 各详情分支对 #rightBody 加 .detail；判定顺序对齐原版：
  // gitdiff 先过 !s/!isGit 兜底，故非 git 时 selectedFile 不进详情）
  const detail =
    (rightTab === "gitdiff" && !!s?.isGit && !!selectedFile) ||
    (rightTab === "file" && !!fileView) ||
    (rightTab === "subagent" && !!selectedSubagent && !!s?.subagents?.has(selectedSubagent));
  let body;
  if (rightTab === null) body = <StartPage />; // tab 全部关闭：居中起始页
  else if (rightTab === "gitdiff") body = <GitDiffPage />;
  else if (rightTab === "bgcmd") body = <BgCmdPage />;
  else if (rightTab === "file") body = <FilePage />;
  else if (rightTab === "tree") body = <BranchTreePage />;
  else if (rightTab === "sessiontree") body = <SessionTreePage />;
  else if (rightTab === "terminal") body = <TerminalPage />;
  else if (rightTab === "browser") body = <BrowserPage />;
  else body = <SubagentPage />;
  return (
    // Provider 局部包在右栏（不动 App.tsx，由协调者统一处理全局层）；400ms 延迟贴近原生 title 观感
    <TooltipProvider delayDuration={400}>
    <aside id="right" className={collapsed ? "collapsed" : ""}>
      <div id="sidepanel">
        <div className="sp-head">
          <Tip label="标签页总览">
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setAddOpen(false);
                setOvOpen(!ovOpen);
              }}
            >
              <Icon name="dots" size={15} />
            </button>
          </Tip>
          <div className="rtabs" id="rightTabs">
            {tabs.map((name) => (
              <TabButton key={name} name={name} on={rightTab === name} />
            ))}
          </div>
          <Tip label="打开标签页">
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setOvOpen(false);
                setAddOpen(!addOpen);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          </Tip>
          {isGitTab && (
            <Tip label="刷新">
              <button
                className="icon-btn"
                id="gitRefresh"
                onClick={(e) => {
                  e.stopPropagation();
                  const cur = activeOpen();
                  if (!cur || !cur.isGit) return;
                  // 清 cwd 强制重拉（换引用写入）
                  setBump({ gitDiffCache: { ...useAppStore.getState().gitDiffCache, cwd: null } });
                  refreshGitDiff();
                }}
              >
                <Icon name="refresh" />
              </button>
            </Tip>
          )}
          {isGitTab && (
            <Tip label="切换树/平铺">
              <button
                className="icon-btn"
                id="gitViewToggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setBump({ gitViewMode: gitViewMode === "tree" ? "flat" : "tree" });
                }}
              >
                {gitViewMode === "tree" ? "树" : "平铺"}
              </button>
            </Tip>
          )}
          {ovOpen && <TabOverview onClose={() => setOvOpen(false)} />}
          {addOpen && <AddTabMenu isGit={!!s?.isGit} onClose={() => setAddOpen(false)} />}
        </div>
        <div id="rightBody" className={detail ? "detail" : ""}>
          {body}
        </div>
      </div>
    </aside>
    </TooltipProvider>
  );
}
