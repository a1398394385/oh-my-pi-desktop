// Settings hub container: fullscreen overlay (left setNav navigation + right setBody page routing).
// Open/page state all comes from the store (settingsOpen / settingsPage selectors +
// openSettings/closeSettings); the container keeps no local open state of its own.
// The appearance side-effect trio (applyAppearance / saveUiPrefs / applyHostAppearance) and
// the font tables live in ui-src/appearance.js (shared by the settings page and global
// shortcuts); re-exported here to preserve the existing export surface.
import { lazy, Suspense, useEffect, useRef, useState, useMemo, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import appIcon from "../../../ui/app-icon.png";
import { useAppStore, openSettings, closeSettings, refreshSettingsData, effZoom } from "../../store";
import { applyAppearance } from "../../appearance";

import Icon from "../../Icon";
import type { AppLang } from "../../i18n";
import { buildKeyToPageMap, HIDDEN_KEYS } from "./placement";
import { LoginBanner, LoginPrompt } from "./common";
import WindowControls from "../WindowControls";
import { IS_WINDOWS } from "../../platform";

// Settings pages are lazy chunks: 27 static page imports dragged every settings
// surface and its dependency subtree (SchemaRows' locale dictionaries, the
// stats live provider, ...) into the startup closure for a rarely opened hub.
// The shell below stays eager; only the page body suspends (a fallback flash
// on first open of each page is expected).
const GeneralPage = lazy(() => import("./pages/GeneralPage"));
const AppearancePage = lazy(() => import("./pages/AppearancePage"));
const KeyboardPage = lazy(() => import("./pages/KeyboardPage"));
const ExperimentalPage = lazy(() => import("./pages/ExperimentalPage"));
const RemotePage = lazy(() => import("./pages/RemotePage"));
const SshPage = lazy(() => import("./pages/SshPage"));
const ComputerPage = lazy(() => import("./pages/ComputerPage"));
const PluginsPage = lazy(() => import("./pages/PluginsPage"));
const ExtensionsPage = lazy(() => import("./pages/ExtensionsPage"));
const HooksPage = lazy(() => import("./pages/HooksPage"));
const ModelPage = lazy(() => import("./pages/ModelPage"));
const McpPage = lazy(() => import("./pages/McpPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const ModelBehaviorPage = lazy(() => import("./pages/ModelBehaviorPage"));
const ProvidersPage = lazy(() => import("./pages/ProvidersPage"));
const CapabilityPage = lazy(() => import("./pages/CapabilityPage"));
const InteractionPage = lazy(() => import("./pages/InteractionPage"));
const ContextPage = lazy(() => import("./pages/ContextPage"));
const FilesPage = lazy(() => import("./pages/FilesPage"));
const ShellPage = lazy(() => import("./pages/ShellPage"));
const ToolsPage = lazy(() => import("./pages/ToolsPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const DeveloperPage = lazy(() => import("./pages/DeveloperPage"));
const AdvancedPage = lazy(() => import("./pages/AdvancedPage"));

// Side navigation items: page id → icon / label (1:1 with the old DOM data-page).
// title/label hold i18n keys; the renderer resolves them via t() per language.
const NAV_SECTIONS = [
  {
    title: "settingsPage.nav.sectionBasic",
    items: [
      { id: "pg-general", icon: "sliders", label: "settingsPage.nav.general" },
      { id: "pg-appearance", icon: "palette", label: "settingsPage.nav.appearance" },
      { id: "pg-model", icon: "box", label: "settingsPage.nav.model" },
      { id: "pg-capabilities", icon: "bulb", label: "settingsPage.nav.capabilities" },
      { id: "pg-computer", icon: "monitor", label: "settingsPage.nav.computer" },
      { id: "pg-remote", icon: "globe", label: "settingsPage.nav.remote" },
      { id: "pg-ssh", icon: "server", label: "ssh.nav" },
      { id: "pg-keyboard", icon: "keyboard", label: "settingsPage.nav.keyboard" },
    ],
  },
  {
    title: "settingsPage.nav.sectionAgent",
    items: [
      { id: "pg-extensions", icon: "extensions", label: "settingsPage.nav.extensions" },
      { id: "pg-memory", icon: "memory", label: "settingsPage.nav.memory" },
      { id: "pg-agents", icon: "agents", label: "settingsPage.nav.subagents" },
      { id: "pg-plugins", icon: "plugins", label: "settingsPage.nav.plugins" },
      { id: "pg-mcp", icon: "mcp", label: "settingsPage.nav.mcp" },
      { id: "pg-skills", icon: "skills", label: "settingsPage.nav.skills" },
      { id: "pg-hooks", icon: "hook", label: "settingsPage.nav.hooks" },
    ],
  },
  {
    title: "settingsPage.nav.sectionBehavior",
    items: [
      { id: "pg-model-behavior", icon: "think", label: "settingsPage.nav.modelBehavior" },
      { id: "pg-providers", icon: "cloud", label: "settingsPage.nav.providers" },
      { id: "pg-interaction", icon: "comment", label: "settingsPage.nav.interaction" },
      { id: "pg-context", icon: "folderOpen", label: "settingsPage.nav.context" },
      { id: "pg-files", icon: "file", label: "settingsPage.nav.files" },
      { id: "pg-shell", icon: "termBox", label: "Shell" },
      { id: "pg-tools", icon: "plug", label: "settingsPage.nav.tools" },
      { id: "pg-tasks", icon: "todo", label: "settingsPage.nav.tasks" },
      { id: "pg-developer", icon: "code", label: "settingsPage.nav.developer" },
      { id: "pg-advanced", icon: "settings", label: "settingsPage.nav.advanced" },
      { id: "pg-experimental", icon: "flask", label: "settingsPage.nav.experimental" },
    ],
  },
  {
    title: "settingsPage.nav.sectionData",
    items: [{ id: "pg-stats", icon: "stats", label: "settingsPage.nav.stats" }],
  },
];

// Current page → page component (integration contract: 14 default-export components under pages/)
// Indexed by page id string with a GeneralPage fallback, hence the wide Record type.
const PAGES: Record<string, ComponentType> = {
  "pg-general": GeneralPage,
  "pg-appearance": AppearancePage,
  "pg-keyboard": KeyboardPage,
  "pg-experimental": ExperimentalPage,
  "pg-remote": RemotePage,
  "pg-ssh": SshPage,
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
  "pg-capabilities": CapabilityPage,
  "pg-interaction": InteractionPage,
  "pg-context": ContextPage,
  "pg-files": FilesPage,
  "pg-shell": ShellPage,
  "pg-tools": ToolsPage,
  "pg-tasks": TasksPage,
  "pg-developer": DeveloperPage,
  "pg-advanced": AdvancedPage,
};

// page id → page-title i18n key (extracted from NAV_SECTIONS)
const PAGE_LABELS: Record<string, string> = {};
for (const sec of NAV_SECTIONS) {
  for (const it of sec.items) {
    PAGE_LABELS[it.id] = it.label;
  }
}

// How long the landed search row keeps its tint. Must stay >= the .search-flash animation
// duration in ui/css/settings/common.css (kept in sync there by SEARCH_FLASH_MS in the comment).
const SEARCH_FLASH_MS = 2600;

// Settings-schema dictionaries (~91KB zh / ~17KB en) load per language on
// first use so neither ships in the startup closure; the loaded value is
// cached module-side so later mounts start synchronous.
type SettingsDict = Record<string, { label: string; description?: string; warning?: string }>;
const settingsDicts = new Map<AppLang, SettingsDict>();
const settingsDictLoads = new Map<AppLang, Promise<SettingsDict>>();
function ensureSettingsDict(lang: AppLang): void {
  if (settingsDicts.has(lang) || settingsDictLoads.has(lang)) return;
  const load =
    lang === "zh-CN"
      ? () => import("../../i18n/locales/settings-zh-CN").then((m) => m.SETTINGS_ZH)
      : () => import("../../i18n/locales/settings-en").then((m) => m.SETTINGS_EN);
  settingsDictLoads.set(
    lang,
    load().then((dict) => {
      settingsDicts.set(lang, dict);
      return dict;
    }),
  );
}

/** All searchable settings items (key/label/description/pageId/pageTitle). Shared by the
 * settings page search and the global search palette. Empty until the current
 * language's schema dictionary chunk has loaded. */
export function useAllSettingsItems() {
  const schema = useAppStore((s) => s.settingsSchema);
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsDict | null>(() => settingsDicts.get(lang) ?? null);
  useEffect(() => {
    ensureSettingsDict(lang);
    let alive = true;
    void settingsDictLoads.get(lang)?.then((dict) => {
      if (alive) setSettings(dict);
    });
    return () => {
      alive = false;
    };
  }, [lang]);
  return useMemo(() => {
    if (!settings) return [];
    const keyToPageMap = buildKeyToPageMap(schema);
    const keys = schema ? Array.from(new Set([...Object.keys(settings), ...Object.keys(schema)])) : Object.keys(settings);
    const items: Array<{ key: string; label: string; description: string; pageId: string; pageTitle: string }> = [];
    for (const k of keys) {
      if (HIDDEN_KEYS[k]) continue; // hidden keys never render, so search must not offer them either
      const entry = settings[k];
      const ui = schema?.[k]?.ui;
      const label = entry?.label ?? ui?.label ?? "";
      const description = entry?.description ?? ui?.description ?? "";
      if (!label && !description) continue;
      const pid = keyToPageMap[k] ?? "pg-advanced";
      const pageTitle = t(PAGE_LABELS[pid] ?? "settingsPage.nav.advanced");
      items.push({ key: k, label, description, pageId: pid, pageTitle });
    }
    // App-level rows (DesktopAlertsSection: uiPrefs, not host schema) — indexed so settings
    // search and the global palette can find them; keys match the rows' data-key attributes.
    items.push(
      { key: "app.notifyDesktop", label: t("settingsPage.alerts.desktopTitle"), description: t("settingsPage.alerts.desktopDesc"), pageId: "pg-interaction", pageTitle: t("settingsPage.nav.interaction") },
      { key: "app.notifySound", label: t("settingsPage.alerts.soundTitle"), description: t("settingsPage.alerts.soundDesc"), pageId: "pg-interaction", pageTitle: t("settingsPage.nav.interaction") },
      { key: "app.notifyPermission", label: t("settingsPage.alerts.permTitle"), description: t("settingsPage.alerts.permGrantedDesc"), pageId: "pg-interaction", pageTitle: t("settingsPage.nav.interaction") },
    );
    return items;
  }, [schema, t, settings]);
}

export default function Settings() {
  const { t } = useTranslation();
  // Selector subscriptions: settingsOpen / settingsPage / hostSettings changes trigger re-render
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settingsPage = useAppStore((s) => s.settingsPage);
  const hostSettings = useAppStore((s) => s.hostSettings);
  const [searchQuery, setSearchQuery] = useState("");
  const setBodyRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  // All settings keys (for search; shared with the global search palette)
  const allSettingsItems = useAllSettingsItems();

  // Search results: only match against every setting item's "label" and "description"; nothing else participates
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

  // Apply local appearance prefs once on mount (the store module already merged uiPrefs from localStorage)
  useEffect(() => {
    applyAppearance();
  }, []);

  // On the first effect after closed→open, fetch settings data and reset the search box (equivalent to old openSettings → refreshSettingsData)
  useEffect(() => {
    const open = !!settingsOpen;
    if (open && !wasOpenRef.current) {
      refreshSettingsData();
      setSearchQuery("");
    }
    wasOpenRef.current = open;
  });

  // Reset right-side scroll on page switch (equivalent to old switchSetPage's setBody.scrollTop = 0)
  const pageId = settingsPage || "pg-general";
  useEffect(() => {
    if (setBodyRef.current) setBodyRef.current.scrollTop = 0;
  }, [pageId]);

  // Esc to close (only when the settings hub is open; listener mounted once, open state read via getState)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().settingsOpen) closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Settings sidebar drag-resize: the right-edge handle adjusts --setnav-w (first column of
  // the #settings grid); persistence key convention matches shell.ts attachResizer. Main-shell
  // coupling constraints (fixed center width etc.) don't apply to the overlay; clamp 150px~40vw
  useEffect(() => {
    const CSS_VAR = "--setnav-w";
    const STORE_KEY = "omp-w-" + CSS_VAR;
    const root = document.documentElement;
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) root.style.setProperty(CSS_VAR, saved + "px");
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation(); // #setNav is a window drag region (data-tauri-drag-region); don't trigger window move
      const nav = document.getElementById("setNav");
      if (!nav) return;
      const startX = e.clientX;
      const startW = nav.offsetWidth;
      const move = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / effZoom();
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

  // Scroll listener: dynamically show scrollbars while scrolling, smoothly fade out after stopping (never persistent)
  useEffect(() => {
    const container = settingsRef.current;
    if (!container || !settingsOpen) return;

    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

    const onScrollCapture = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.classList) return;
      target.classList.add("scrolling");
      const existing = timers.get(target);
      if (existing) clearTimeout(existing);
      timers.set(
        target,
        setTimeout(() => {
          target.classList.remove("scrolling");
          timers.delete(target);
        }, 600),
      );
    };

    container.addEventListener("scroll", onScrollCapture, { capture: true, passive: true });
    return () => {
      container.removeEventListener("scroll", onScrollCapture, { capture: true });
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [settingsOpen]);

  const Page = PAGES[pageId] || GeneralPage;
  const profileName = (hostSettings && hostSettings.activeProfile) || "default";

  return (
    <div id="settings" ref={settingsRef} className={settingsOpen ? "" : "hidden"}>
      {/* OMP login-in-progress banner + paste-code dialog: mounted at the shell root so page switches or logging in on any settings page don't interrupt it (old version mounted globally on document.body) */}
      <LoginBanner />
      <LoginPrompt />
      <nav id="setNav" data-tauri-drag-region>
        <div id="setNavResizer" title={t("settingsPage.shell.dragResize")}></div>
        <button type="button" className="set-back" id="setBack" onClick={closeSettings}>
          <Icon name="back" size={14} />
          {t("settingsPage.shell.backToWorkspace")}
        </button>
        <div className="set-search-wrap">
          <span className="set-search-icon">
            <Icon name="search" size={13} />
          </span>
          <input
            type="text"
            className="set-search-input"
            id="setSearchInput"
            placeholder={t("settingsPage.shell.searchPlaceholder")}
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
              title={t("settingsPage.shell.searchClear")}
            >
              <Icon name="xmark" size={11} />
            </button>
          )}
        </div>
        <div className="set-nav-scroll">
          {searchResults ? (
            <div className="set-search-results">
              <div className="set-search-count">{t("settingsPage.shell.searchCount", { count: searchResults.length })}</div>
              {searchResults.length === 0 ? (
                <div className="set-search-empty">{t("settingsPage.shell.searchEmpty")}</div>
              ) : (
                searchResults.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={"set-search-item" + (pageId === it.pageId ? " on" : "")}
                    onClick={() => {
                      openSettings(it.pageId);
                      // Land on the row: page render + entrance animations settle in a
                      // couple of frames, then scroll it into view and hold the tint long
                      // enough to actually see (SEARCH_FLASH_MS mirrors the CSS duration).
                      setTimeout(() => {
                        const el = setBodyRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(it.key)}"]`);
                        el?.scrollIntoView({ block: "center", behavior: "smooth" });
                        el?.classList.add("search-flash");
                        setTimeout(() => el?.classList.remove("search-flash"), SEARCH_FLASH_MS);
                      }, 80);
                    }}
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
                <div className="set-sec">{t(sec.title)}</div>
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
                    {t(it.label)}
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
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </div>
      {/* Windows frameless window controls: the fullscreen settings overlay (z-index 300) covers
          the shell headers that normally carry .win-controls (chat-head / sp-head), so the
          overlay pins its own copy to the setBody card's top-right corner. Windows only, and
          only while open (a hidden copy would keep a redundant resize listener alive);
          the component no-ops in browser preview (no window API). */}
      {IS_WINDOWS && settingsOpen && (
        <div className="set-win-ctl">
          <WindowControls />
        </div>
      )}
    </div>
  );
}
