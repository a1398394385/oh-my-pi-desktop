// Appearance preferences: persisted to localStorage + applied to
// documentElement (CSS variables and dataset switches).
// The single implementation shared by the settings page (Settings container)
// and global shortcuts (Ctrl+T in keys.js), ported from the old
// ui/settings/index.js saveUiPrefs / applyAppearance / applyHostAppearance.
import { useAppStore } from "./store";

const UI_PREF_KEY = "omp-ui-settings";

// Font options: shared by the appearance page font dropdown and applyAppearance
export const FONT_LABELS: Record<string, string> = {
  default: "系统默认",
  zcode: "标准系统无衬线",
  pingfang: "苹方 / PingFang SC",
  songti: "宋体 / Songti SC",
  kaiti: "楷体 / KaiTi SC",
  heiti: "黑体 / Heiti SC",
  mono: "等宽",
};
export const FONT_STACKS: Record<string, string> = {
  default: "var(--sans)",
  zcode: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

// Persist appearance preferences (localStorage)
export function saveUiPrefs(): void {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(useAppStore.getState().uiPrefs));
  } catch {}
}

// Appearance preferences -> documentElement CSS variables and dataset switches
export function applyAppearance(): void {
  const { uiPrefs } = useAppStore.getState();
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}

// The purely-appearance side effects of host settings: only hideThinkingBlock
// affects appearance -- synced into uiPrefs.showThinking, persisted and applied.
// The other host fields (proxy/timeouts/toggles) are rendered under control by
// page components with S.hostSettings as the data source.
export function applyHostAppearance(hostSettings: { hideThinkingBlock?: unknown } | null | undefined): void {
  if (!hostSettings || typeof hostSettings.hideThinkingBlock !== "boolean") return;
  const showThinking = !hostSettings.hideThinkingBlock;
  // Write a new object (selector components sense it by reference) + _v bump
  // (old useStore subscription fallback)
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking } }));
  saveUiPrefs();
  applyAppearance();
}
