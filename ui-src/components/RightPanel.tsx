// Right panel: tab head at the very top (ZCode Side Pane style: left overview popover / middle
// equal-width draggable tabs / right add button) + panel body. Migrated from ui/right.js (the
// old top logo toolbar removed, tab bar pinned to top). The open-tab list and active tab live
// in the store (ordered rightTabs / rightTab), subscribed via selectors here; tab management is
// in ./right/tabs.js (shared by all pages), re-exported here to preserve the existing export surface.
// Contract: data subscribed via useAppStore selectors (current session / rightTab /
// selectedFile etc.), writes go through setBump and existing functions; the three detail pages
// (gitdiff file / file view / subagent) keep the finalized skeleton:
// #rightBody gets the detail class, fixed rb-head + scrolling rb-scroll (style.css
// #rightBody.detail rules).
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, activeOpen, refreshGitDiff } from "../store";
import Icon from "../Icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  TAB_META,
  AUTO_TABS,
  openRightTab, closeRightTab, reopenRightTab, moveRightTab,
} from "./right/tabs";
import StartPage from "./right/StartPage";
import SubagentPage from "./right/SubagentPage";
import HubDetailPage from "./right/HubDetailPage";
import GitDiffPage from "./right/GitDiffPage";
import FilePage from "./right/FilePage";
import BgCmdPage from "./right/BgCmdPage";
import BranchTreePage from "./right/BranchTreePage";
import SessionTreePage from "./right/SessionTreePage";
import TerminalPage from "./right/TerminalPage";
import BrowserPage from "./right/BrowserPage";
import CapabilitiesPage from "./right/CapabilitiesPage";
import { t } from "../i18n";
import WindowControls from "./WindowControls";
import { IS_WINDOWS } from "../platform";

// Preserve the existing export surface (tab management implementation split into right/tabs.js)
export { TAB_META, openRightTab, closeRightTab } from "./right/tabs";

// Tab head hover tips: native title swapped for Radix Tooltip (popover card visuals via the
// ui/tooltip primitive).
// children must be a DOM element that accepts a ref (Radix Trigger injects the ref via asChild
// as the positioning anchor)
function Tip({ label, children }: { label?: string; children: ReactElement }) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

// "Recently closed" relative time: just now / N min ago / N h ago / N days ago
function closedAgo(at: number): string {
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) return t("right.closedNow");
  if (m < 60) return t("right.closedMin", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("right.closedHour", { n: h });
  return t("right.closedDay", { n: Math.floor(h / 24) });
}

// Tab overview popover: search box + open tabs (click to switch / close per item) + recently
// closed (click to reopen).
// Reuses the .menu popover visuals; coordinates use sp-head-relative positioning (absolute
// scales with the panel zoom without misplacement).
function TabOverview({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
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
  const match = (name: string) => !kw || t(TAB_META[name].label).toLowerCase().includes(kw);
  const opens = rightTabs.filter(match);
  const recents = rightRecentClosed.filter((x) => match(x.name));
  return (
    <div className="menu open sp-pop" onClick={(e) => e.stopPropagation()}>
      <div className="sp-pop-search">
        <Icon name="search" size={15} />
        <input
          ref={inputRef}
          placeholder={t("right.searchTabs")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="sp-pop-scroll">
        <div className="mh">{t("right.openTabs")}</div>
        {opens.length === 0 && <div className="mi empty">{t("right.noMatchTabs")}</div>}
        {opens.map((name) => (
          <div
            key={name}
            className={"mi" + (rightTab === name ? " on" : "")}
            onClick={() => { setBump({ rightTab: name }); onClose(); }}
          >
            <span className="mi-ic"><Icon name={TAB_META[name].icon} size={15} /></span>
            {t(TAB_META[name].label)}
            {!AUTO_TABS.has(name) && (
              <Tip label={t("common.close")}>
                <span
                  className="mi-x"
                  onClick={(e) => { e.stopPropagation(); closeRightTab(name); if (!useAppStore.getState().rightTabs.length) onClose(); }}
                >
                  <Icon name="xmark" size={12} />
                </span>
              </Tip>
            )}
          </div>
        ))}
        {recents.length > 0 && <div className="mh">{t("right.recentlyClosed")}</div>}
        {recents.map((x) => (
          <div key={x.name} className="mi" onClick={() => { reopenRightTab(x.name); onClose(); }}>
            <span className="mi-ic"><Icon name={TAB_META[x.name].icon} size={15} /></span>
            {t(TAB_META[x.name].label)}
            <span className="sub">{closedAgo(x.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// "Add" menu: lists every openable tab (opened ones checkmarked, git-only entries grayed when
// not a git repo)
function AddTabMenu({
  isGit,
  menuLeft,
  onClose,
}: {
  isGit: boolean;
  menuLeft?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rightTabs = useAppStore((st) => st.rightTabs);
  return (
    <div
      className="menu open sp-pop sp-add"
      style={{
        left: menuLeft !== undefined ? `${Math.round(menuLeft)}px` : undefined,
        right: "auto",
        visibility: menuLeft !== undefined ? "visible" : "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sp-pop-scroll">
        {Object.keys(TAB_META)
          .filter((name) => !AUTO_TABS.has(name))
          .map((name) => {
            const off = name === "gitdiff" && !isGit;
            const on = rightTabs.includes(name);
            return (
              <Tip key={name} label={off ? t("right.notGitRepo") : undefined}>
                <div
                  className={"mi" + (off ? " empty" : "")}
                  onClick={off ? undefined : () => { openRightTab(name); onClose(); }}
                >
                  <span className="ck">{on ? "✓" : ""}</span>
                  <span className="mi-ic"><Icon name={TAB_META[name].icon} size={15} /></span>
                  {t(TAB_META[name].label)}
                </div>
              </Tip>
            );
          })}
      </div>
    </div>
  );
}

// Single tab: equal-width flex, native drag reorder, hover-only close button, middle-click close.
// Auto tabs (the Agent Hub linkage) have no close affordance — their lifecycle is tied to the hub.
function TabButton({ name, on }: { name: string; on: boolean }) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const auto = AUTO_TABS.has(name);
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
        if (e.button === 1 && !auto) {
          e.preventDefault();
          closeRightTab(name);
        }
      }}
    >
      <span className="rtab-ic"><Icon name={TAB_META[name].icon} size={15} /></span>
      <span className="rtab-tx">{t(TAB_META[name].label)}</span>
      {!auto && (
        <Tip label={t("common.close")}>
          <span
            className="rtab-x"
            onClick={(e) => { e.stopPropagation(); closeRightTab(name); }}
          >
            <Icon name="xmark" size={12} />
          </span>
        </Tip>
      )}
    </button>
  );
}

export default function RightPanel({ collapsed }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  // Current session + all scattered right-panel fields subscribed per field (openRightTab etc.
  // don't bump _v; field subscriptions drive re-render)
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightTabs = useAppStore((st) => st.rightTabs); // tab list lives in the store: field subscription drives re-render
  const rightTab = useAppStore((st) => st.rightTab);
  const selectedFile = useAppStore((st) => st.selectedFile);
  const fileView = useAppStore((st) => st.fileView);
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  const gitViewMode = useAppStore((st) => st.gitViewMode);
  const [ovOpen, setOvOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const headRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [menuLeft, setMenuLeft] = useState<number | undefined>(undefined);

  const updateAddMenuPos = () => {
    if (addBtnRef.current && headRef.current) {
      const headRect = headRef.current.getBoundingClientRect();
      const btnRect = addBtnRef.current.getBoundingClientRect();
      const z = useAppStore.getState().zoomLevel || 1;
      const headWidth = headRect.width / z;
      const btnLeft = (btnRect.left - headRect.left) / z;
      const btnRight = (headRect.right - btnRect.right) / z;
      const btnWidth = btnRect.width / z;
      const menuWidth = 248; // .sp-head .menu.sp-pop is fixed-width 248px
      const pad = 6;
      const minLeft = pad;
      const maxLeft = Math.max(pad, headWidth - menuWidth - pad);
      const btnCenter = btnLeft + btnWidth / 2;
      const headCenter = headWidth / 2;
      const targetLeft = btnCenter < headCenter ? btnLeft : headWidth - btnRight - menuWidth;
      setMenuLeft(Math.max(minLeft, Math.min(targetLeft, maxLeft)));
    }
  };

  useLayoutEffect(() => {
    if (!addOpen) {
      setMenuLeft(undefined);
      return;
    }
    updateAddMenuPos();
    const tabsEl = tabsRef.current;
    window.addEventListener("resize", updateAddMenuPos);
    window.addEventListener("omp:zoom", updateAddMenuPos);
    tabsEl?.addEventListener("scroll", updateAddMenuPos);
    return () => {
      window.removeEventListener("resize", updateAddMenuPos);
      window.removeEventListener("omp:zoom", updateAddMenuPos);
      tabsEl?.removeEventListener("scroll", updateAddMenuPos);
    };
  }, [addOpen, rightTabs]);

  // Popover closes uniformly go through omp:close-menus (port of window click/blur →
  // closeAllMenus); trigger buttons themselves stopPropagation so the global close doesn't hit them
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
  // Non-git sessions keep no Git Diff tab (both the open list and the active tab fall back).
  // Restored snapshots may also carry a stale "hub" tab without a live hub — drop it.
  const hubOpen = useAppStore((st) => st.hubOpen);
  let tabs = rightTabs;
  if (!hubOpen && tabs.includes("hub")) tabs = tabs.filter((n) => n !== "hub");
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
  const isCapsTab = rightTab === "caps";
  const detail =
    (rightTab === "gitdiff" && !!s?.isGit && !!selectedFile) ||
    (rightTab === "file" && !!fileView) ||
    (rightTab === "subagent" && !!selectedSubagent && !!s?.subagents?.has(selectedSubagent));
  let body;
  if (rightTab === "hub") body = <HubDetailPage />;
  else if (rightTab === null) body = <StartPage />; // all tabs closed: centered start page
  else if (rightTab === "gitdiff") body = <GitDiffPage />;
  else if (rightTab === "bgcmd") body = <BgCmdPage />;
  else if (rightTab === "file") body = <FilePage />;
  else if (rightTab === "tree") body = <BranchTreePage />;
  else if (rightTab === "sessiontree") body = <SessionTreePage />;
  else if (rightTab === "terminal") body = <TerminalPage />;
  else if (rightTab === "browser") body = <BrowserPage />;
  else if (rightTab === "caps") body = <CapabilitiesPage />;
  else body = <SubagentPage />;
  return (
    // Provider scoped locally to the right panel (App.tsx untouched; the coordinator handles
    // the global layer); 400ms delay approximates the native title feel
    <TooltipProvider delayDuration={400}>
    <aside id="right" className={collapsed ? "collapsed" : ""}>
      <div id="sidepanel">
        <div className="sp-head" ref={headRef} data-tauri-drag-region="">
          <Tip label={t("right.tabOverview")}>
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setAddOpen(false);
                setOvOpen(!ovOpen);
              }}
            >
              <Icon name="chevronsDown" size={15} />
            </button>
          </Tip>
          <div className="rtabs" id="rightTabs" ref={tabsRef}>
            {tabs.map((name) => (
              <TabButton key={name} name={name} on={rightTab === name} />
            ))}
            <Tip label={t("right.openTab")}>
              <button
                ref={addBtnRef}
                className={"icon-btn shrink-0" + (addOpen ? " on" : "")}
                onClick={(e) => {
                  e.stopPropagation();
                  setOvOpen(false);
                  if (!addOpen) {
                    updateAddMenuPos();
                    setAddOpen(true);
                  } else {
                    setAddOpen(false);
                  }
                }}
              >
                <Icon name="plus" size={15} />
              </button>
            </Tip>
          </div>
          {isGitTab && (
            <Tip label={t("right.refresh")}>
              <button
                className="icon-btn"
                id="gitRefresh"
                onClick={(e) => {
                  e.stopPropagation();
                  const cur = activeOpen();
                  if (!cur || !cur.isGit) return;
                  // Clear cwd to force a refetch (fresh-reference write)
                  setBump({ gitDiffCache: { ...useAppStore.getState().gitDiffCache, cwd: null } });
                  refreshGitDiff();
                }}
              >
                <Icon name="refresh" />
              </button>
            </Tip>
          )}
          {isGitTab && (
            <Tip label={t("right.toggleTreeFlat")}>
              <button
                className="icon-btn"
                id="gitViewToggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setBump({ gitViewMode: gitViewMode === "tree" ? "flat" : "tree" });
                }}
              >
                {gitViewMode === "tree" ? t("right.treeView") : t("right.flatView")}
              </button>
            </Tip>
           )}
          {isCapsTab && (
            <Tip label={t("right.refresh")}>
              <button
                className="icon-btn"
                id="capsRefresh"
                onClick={(e) => {
                  e.stopPropagation();
                  useAppStore.getState().fetchCapabilities();
                }}
              >
                <Icon name="refresh" />
              </button>
            </Tip>
          )}
          {IS_WINDOWS && !collapsed && <WindowControls />}
          {ovOpen && <TabOverview onClose={() => setOvOpen(false)} />}
          {addOpen && (
            <AddTabMenu
              isGit={!!s?.isGit}
              menuLeft={menuLeft}
              onClose={() => setAddOpen(false)}
            />
          )}
        </div>
        <div id="rightBody" className={detail ? "detail" : ""}>
          {body}
        </div>
      </div>
    </aside>
    </TooltipProvider>
  );
}
