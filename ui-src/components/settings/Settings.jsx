// 设置中心容器：全屏 overlay（左侧 setNav 导航 + 右侧 setBody 页面路由）。
// 开合/切页状态全部来自 store（S.settingsOpen / S.settingsPage + openSettings/closeSettings），
// 容器自身无本地开合状态。
// 外观副作用三件套（applyAppearance / saveUiPrefs / applyHostAppearance）与字体表住在
// ui-src/appearance.js（设置页与全局快捷键共用），此处 re-export 保持既有导出面。
import { useEffect, useRef } from "react";
import { S, useStore, openSettings, closeSettings, refreshSettingsData } from "../../store.js";
import { applyAppearance } from "../../appearance.js";

export { FONT_LABELS, FONT_STACKS, saveUiPrefs, applyAppearance, applyHostAppearance } from "../../appearance.js";
import Icon from "../../Icon.jsx";
import { LoginBanner, LoginPrompt } from "./common.jsx";
import GeneralPage from "./pages/GeneralPage.jsx";
import AppearancePage from "./pages/AppearancePage.jsx";
import KeyboardPage from "./pages/KeyboardPage.jsx";
import ExperimentalPage from "./pages/ExperimentalPage.jsx";
import BrowserPage from "./pages/BrowserPage.jsx";
import ComputerPage from "./pages/ComputerPage.jsx";
import PluginsPage from "./pages/PluginsPage.jsx";
import HooksPage from "./pages/HooksPage.jsx";
import CommandsPage from "./pages/CommandsPage.jsx";
import ModelPage from "./pages/ModelPage.jsx";
import McpPage from "./pages/McpPage.jsx";
import SkillsPage from "./pages/SkillsPage.jsx";
import MemoryPage from "./pages/MemoryPage.jsx";
import AgentsPage from "./pages/AgentsPage.jsx";
import StatsPage from "./pages/StatsPage.jsx";
import ModelBehaviorPage from "./pages/ModelBehaviorPage.jsx";
import ProvidersPage from "./pages/ProvidersPage.jsx";
import InteractionPage from "./pages/InteractionPage.jsx";
import ContextPage from "./pages/ContextPage.jsx";
import FilesPage from "./pages/FilesPage.jsx";
import ShellPage from "./pages/ShellPage.jsx";
import ToolsPage from "./pages/ToolsPage.jsx";
import TasksPage from "./pages/TasksPage.jsx";
import AdvancedPage from "./pages/AdvancedPage.jsx";

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
      { id: "pg-experimental", icon: "flask", label: "实验性功能" },
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
    ],
  },
  {
    title: "Agent 能力",
    items: [
      { id: "pg-memory", icon: "memory", label: "记忆" },
      { id: "pg-agents", icon: "agents", label: "子智能体" },
      { id: "pg-plugins", icon: "plugins", label: "插件" },
      { id: "pg-mcp", icon: "mcp", label: "MCP 服务器" },
      { id: "pg-skills", icon: "skills", label: "技能" },
      { id: "pg-commands", icon: "commands", label: "命令" },
      { id: "pg-hooks", icon: "hook", label: "钩子" },
    ],
  },
  {
    title: "数据与统计",
    items: [{ id: "pg-stats", icon: "stats", label: "使用统计" }],
  },
];

// 当前页 → 页面组件（集成契约：pages/ 下 14 个默认导出组件）
const PAGES = {
  "pg-general": GeneralPage,
  "pg-appearance": AppearancePage,
  "pg-keyboard": KeyboardPage,
  "pg-experimental": ExperimentalPage,
  "pg-browser": BrowserPage,
  "pg-computer": ComputerPage,
  "pg-plugins": PluginsPage,
  "pg-hooks": HooksPage,
  "pg-commands": CommandsPage,
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

export default function Settings() {
  useStore(); // 订阅 S：settingsOpen / settingsPage / hostSettings 变化触发重渲染
  const setBodyRef = useRef(null);
  const wasOpenRef = useRef(false);

  // 挂载即应用一次本地外观偏好（store 模块级已从 localStorage 合并 uiPrefs）
  useEffect(() => {
    applyAppearance();
  }, []);

  // 从关闭到打开的首个 effect 里拉取设置数据（等价旧版 openSettings → refreshSettingsData）
  useEffect(() => {
    const open = !!S.settingsOpen;
    if (open && !wasOpenRef.current) refreshSettingsData();
    wasOpenRef.current = open;
  });

  // 切页时重置右侧滚动位置（等价旧版 switchSetPage 的 setBody.scrollTop = 0）
  const pageId = S.settingsPage || "pg-general";
  useEffect(() => {
    if (setBodyRef.current) setBodyRef.current.scrollTop = 0;
  }, [pageId]);

  // Esc 关闭（仅当设置中心打开时）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && S.settingsOpen) closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Page = PAGES[pageId] || GeneralPage;
  const profileName = (S.hostSettings && S.hostSettings.activeProfile) || "omp-desktop";

  return (
    <div id="settings" className={S.settingsOpen ? "" : "hidden"}>
      {/* OMP 登录进行中横幅 + 粘贴码弹窗：挂壳根部，切页/在设置内任何页登录都不中断（旧版挂 document.body 全局） */}
      <LoginBanner />
      <LoginPrompt />
      <nav id="setNav" data-tauri-drag-region>
        <button type="button" className="set-back" id="setBack" onClick={closeSettings}>
          <Icon name="back" size={14} />
          返回工作区
        </button>
        {NAV_SECTIONS.map((sec) => (
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
        ))}
        <div className="set-foot">
          <span className="avatar">
            <img src="app-icon.png" alt="" />
          </span>
          <span className="uname" id="setFootProfile">
            {profileName}
          </span>
        </div>
      </nav>
      <div id="setBody" ref={setBodyRef}>
        <Page />
      </div>
    </div>
  );
}
