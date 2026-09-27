// 设置中心容器：全屏 overlay（左侧 setNav 导航 + 右侧 setBody 页面路由）。
// 开合/切页状态全部来自 store（settingsOpen / settingsPage selector + openSettings/closeSettings），
// 容器自身无本地开合状态。
// 外观副作用三件套（applyAppearance / saveUiPrefs / applyHostAppearance）与字体表住在
// ui-src/appearance.js（设置页与全局快捷键共用），此处 re-export 保持既有导出面。
import { useEffect, useRef, useState, useMemo, type ComponentType } from "react";
import appIcon from "../../../ui/app-icon.png";
import { useAppStore, openSettings, closeSettings, refreshSettingsData } from "../../store";
import { applyAppearance } from "../../appearance";

export { FONT_LABELS, FONT_STACKS, saveUiPrefs, applyAppearance, applyHostAppearance } from "../../appearance";
import Icon from "../../Icon";
import { SETTINGS_ZH } from "./settings-zh";
import { buildKeyToPageMap } from "./placement";
import { LoginBanner, LoginPrompt } from "./common";
import GeneralPage from "./pages/GeneralPage";
import AppearancePage from "./pages/AppearancePage";
import KeyboardPage from "./pages/KeyboardPage";
import ExperimentalPage from "./pages/ExperimentalPage";
import BrowserPage from "./pages/BrowserPage";
import ComputerPage from "./pages/ComputerPage";
import PluginsPage from "./pages/PluginsPage";
import ExtensionsPage from "./pages/ExtensionsPage";
import HooksPage from "./pages/HooksPage";
import ModelPage from "./pages/ModelPage";
import McpPage from "./pages/McpPage";
import SkillsPage from "./pages/SkillsPage";
import MemoryPage from "./pages/MemoryPage";
import AgentsPage from "./pages/AgentsPage";
import StatsPage from "./pages/StatsPage";
import ModelBehaviorPage from "./pages/ModelBehaviorPage";
import ProvidersPage from "./pages/ProvidersPage";
import InteractionPage from "./pages/InteractionPage";
import ContextPage from "./pages/ContextPage";
import FilesPage from "./pages/FilesPage";
import ShellPage from "./pages/ShellPage";
import ToolsPage from "./pages/ToolsPage";
import TasksPage from "./pages/TasksPage";
import AdvancedPage from "./pages/AdvancedPage";

// 侧边导航项：page id → 图标 / 文案（与旧版 DOM data-page 一一对应）
const NAV_SECTIONS = [
  {
    title: "基础设置",
    items: [
      { id: "pg-general", icon: "sliders", label: "常规" },
      { id: "pg-appearance", icon: "palette", label: "外观" },
      { id: "pg-model", icon: "box", label: "模型设置" },
      { id: "pg-browser", icon: "globe", label: "浏览器控制" },
      { id: "pg-computer", icon: "monitor", label: "电脑控制" },
      { id: "pg-keyboard", icon: "keyboard", label: "键盘快捷键" },
    ],
  },
  {
    title: "Agent 能力",
    items: [
      { id: "pg-extensions", icon: "extensions", label: "扩展" },
      { id: "pg-memory", icon: "memory", label: "记忆" },
      { id: "pg-agents", icon: "agents", label: "子智能体" },
      { id: "pg-plugins", icon: "plugins", label: "插件" },
      { id: "pg-mcp", icon: "mcp", label: "MCP 服务器" },
      { id: "pg-skills", icon: "skills", label: "技能" },
      { id: "pg-hooks", icon: "hook", label: "钩子" },
    ],
  },
  {
    title: "行为与规则",
    items: [
      { id: "pg-model-behavior", icon: "think", label: "模型行为" },
      { id: "pg-providers", icon: "cloud", label: "服务商" },
      { id: "pg-interaction", icon: "comment", label: "交互" },
      { id: "pg-context", icon: "folderOpen", label: "上下文" },
      { id: "pg-files", icon: "file", label: "文件" },
      { id: "pg-shell", icon: "termBox", label: "Shell" },
      { id: "pg-tools", icon: "plug", label: "工具" },
      { id: "pg-tasks", icon: "todo", label: "任务·子代理" },
      { id: "pg-advanced", icon: "settings", label: "高级" },
      { id: "pg-experimental", icon: "flask", label: "实验性功能" },
    ],
  },
  {
    title: "数据与统计",
    items: [{ id: "pg-stats", icon: "stats", label: "使用统计" }],
  },
];

// 当前页 → 页面组件（集成契约：pages/ 下 14 个默认导出组件）
// 以 page id 字符串索引，取值不到时回落 GeneralPage，故用 Record 宽类型。
const PAGES: Record<string, ComponentType> = {
  "pg-general": GeneralPage,
  "pg-appearance": AppearancePage,
  "pg-keyboard": KeyboardPage,
  "pg-experimental": ExperimentalPage,
  "pg-browser": BrowserPage,
  "pg-computer": ComputerPage,
  "pg-plugins": PluginsPage,
  "pg-extensions": ExtensionsPage,
  "pg-hooks": HooksPage,
  "pg-model": ModelPage,
  "pg-mcp": McpPage,
  "pg-skills": SkillsPage,
  "pg-memory": MemoryPage,
  "pg-agents": AgentsPage,
  "pg-stats": StatsPage,
  "pg-model-behavior": ModelBehaviorPage,
  "pg-providers": ProvidersPage,
  "pg-interaction": InteractionPage,
  "pg-context": ContextPage,
  "pg-files": FilesPage,
  "pg-shell": ShellPage,
  "pg-tools": ToolsPage,
  "pg-tasks": TasksPage,
  "pg-advanced": AdvancedPage,
};

// 页面 ID 到页面中文标题的映射（从 NAV_SECTIONS 提取）
const PAGE_LABELS: Record<string, string> = {};
for (const sec of NAV_SECTIONS) {
  for (const it of sec.items) {
    PAGE_LABELS[it.id] = it.label;
  }
}

export default function Settings() {
  // selector 订阅：settingsOpen / settingsPage / hostSettings 变化触发重渲染
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settingsPage = useAppStore((s) => s.settingsPage);
  const hostSettings = useAppStore((s) => s.hostSettings);
  const schema = useAppStore((s) => s.settingsSchema);
  const [searchQuery, setSearchQuery] = useState("");
  const setBodyRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  // 映射字典：根据 placement.ts 定位 key 所属的 pageId
  const keyToPageMap = useMemo(() => buildKeyToPageMap(schema), [schema]);

  // 所有设置项集合（供搜索用）
  const allSettingsItems = useMemo(() => {
    const keys = schema ? Array.from(new Set([...Object.keys(SETTINGS_ZH), ...Object.keys(schema)])) : Object.keys(SETTINGS_ZH);
    const items: Array<{ key: string; label: string; description: string; pageId: string; pageTitle: string }> = [];
    for (const k of keys) {
      const zh = SETTINGS_ZH[k];
      const ui = schema?.[k]?.ui;
      const label = zh?.label ?? ui?.label ?? "";
      const description = zh?.description ?? ui?.description ?? "";
      if (!label && !description) continue;
      const pid = keyToPageMap[k] ?? "pg-advanced";
      const pageTitle = PAGE_LABELS[pid] ?? "高级";
      items.push({ key: k, label, description, pageId: pid, pageTitle });
    }
    return items;
  }, [schema, keyToPageMap]);

  // 搜索结果：仅在所有设置项的“标题（label）”和“描述（description）”中搜索，其他内容不参与搜索
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const results: Array<{ key: string; label: string; description: string; pageId: string; pageTitle: string; score: number }> = [];
    for (const item of allSettingsItems) {
      const matchLabel = item.label.toLowerCase().includes(q);
      const matchDesc = item.description.toLowerCase().includes(q);
      if (matchLabel || matchDesc) {
        results.push({
          ...item,
          score: (matchLabel ? 2 : 0) + (matchDesc ? 1 : 0),
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }, [searchQuery, allSettingsItems]);

  // 挂载即应用一次本地外观偏好（store 模块级已从 localStorage 合并 uiPrefs）
  useEffect(() => {
    applyAppearance();
  }, []);

  // 从关闭到打开的首个 effect 里拉取设置数据并重置搜索框（等价旧版 openSettings → refreshSettingsData）
  useEffect(() => {
    const open = !!settingsOpen;
    if (open && !wasOpenRef.current) {
      refreshSettingsData();
      setSearchQuery("");
    }
    wasOpenRef.current = open;
  });

  // 切页时重置右侧滚动位置（等价旧版 switchSetPage 的 setBody.scrollTop = 0）
  const pageId = settingsPage || "pg-general";
  useEffect(() => {
    if (setBodyRef.current) setBodyRef.current.scrollTop = 0;
  }, [pageId]);

  // Esc 关闭（仅当设置中心打开时；监听只挂一次，开合态经 getState 读最新值）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().settingsOpen) closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 设置侧栏拖宽：右缘拖柄调 --setnav-w（#settings grid 第一列），
  // 持久化键约定同 shell.ts attachResizer；主壳联动约束（中栏保宽等）不适用于 overlay，只限 150px~40vw
  useEffect(() => {
    const CSS_VAR = "--setnav-w";
    const STORE_KEY = "omp-w-" + CSS_VAR;
    const root = document.documentElement;
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) root.style.setProperty(CSS_VAR, saved + "px");
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation(); // #setNav 是窗口拖动区（data-tauri-drag-region），别触发窗口移动
      const nav = document.getElementById("setNav");
      if (!nav) return;
      const startX = e.clientX;
      const startW = nav.offsetWidth;
      const move = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / useAppStore.getState().zoomLevel;
        const wWin = document.documentElement.clientWidth || window.innerWidth || 1000;
        const w = Math.round(Math.max(150, Math.min(startW + dx, wWin * 0.4)));
        root.style.setProperty(CSS_VAR, w + "px");
        try {
          localStorage.setItem(STORE_KEY, String(w));
        } catch {}
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
      };
      document.body.classList.add("resizing");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    const handle = document.getElementById("setNavResizer");
    handle?.addEventListener("mousedown", onDown);
    return () => handle?.removeEventListener("mousedown", onDown);
  }, []);

  const Page = PAGES[pageId] || GeneralPage;
  const profileName = (hostSettings && hostSettings.activeProfile) || "default";

  return (
    <div id="settings" className={settingsOpen ? "" : "hidden"}>
      {/* OMP 登录进行中横幅 + 粘贴码弹窗：挂壳根部，切页/在设置内任何页登录都不中断（旧版挂 document.body 全局） */}
      <LoginBanner />
      <LoginPrompt />
      <nav id="setNav" data-tauri-drag-region>
        <div id="setNavResizer" title="拖动调整宽度"></div>
        <button type="button" className="set-back" id="setBack" onClick={closeSettings}>
          <Icon name="back" size={14} />
          返回工作区
        </button>
        <div className="set-search-wrap">
          <span className="set-search-icon">
            <Icon name="search" size={13} />
          </span>
          <input
            type="text"
            className="set-search-input"
            id="setSearchInput"
            placeholder="搜索设置项..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) {
                e.stopPropagation();
                setSearchQuery("");
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {searchQuery && (
            <button
              type="button"
              className="set-search-clear"
              id="setSearchClear"
              onClick={() => setSearchQuery("")}
              title="清空搜索"
            >
              <Icon name="xmark" size={11} />
            </button>
          )}
        </div>
        <div className="set-nav-scroll">
          {searchResults ? (
            <div className="set-search-results">
              <div className="set-search-count">找到 {searchResults.length} 个设置项</div>
              {searchResults.length === 0 ? (
                <div className="set-search-empty">未找到匹配设置项</div>
              ) : (
                searchResults.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={"set-search-item" + (pageId === it.pageId ? " on" : "")}
                    onClick={() => openSettings(it.pageId)}
                    title={`${it.label} (${it.pageTitle})`}
                  >
                    <div className="set-search-item-main">
                      <span className="set-search-item-label">{it.label}</span>
                      <span className="set-search-item-page">{it.pageTitle}</span>
                    </div>
                    {it.description && (
                      <div className="set-search-item-desc">{it.description}</div>
                    )}
                  </button>
                ))
              )}
            </div>
          ) : (
            NAV_SECTIONS.map((sec) => (
              <div key={sec.title}>
                <div className="set-sec">{sec.title}</div>
                {sec.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    className={"set-item" + (pageId === it.id ? " on" : "")}
                    data-page={it.id}
                    onClick={() => openSettings(it.id)}
                  >
                    <span className="si">
                      <Icon name={it.icon} size={14} />
                    </span>
                    {it.label}
                  </button>
                ))}
              </div>
            ))
          )}
          <div className="set-foot">
            <span className="avatar">
              <img src={appIcon} alt="" />
            </span>
            <span className="uname" id="setFootProfile">
              {profileName}
            </span>
          </div>
        </div>
      </nav>
      <div id="setBody" ref={setBodyRef}>
        <Page />
      </div>
    </div>
  );
}
