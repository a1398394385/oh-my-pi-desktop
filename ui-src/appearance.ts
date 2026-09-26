// 外观偏好：localStorage 落盘 + documentElement 落地（CSS 变量与 dataset 开关）。
// 设置页（Settings 容器）与全局快捷键（keys.js 的 Ctrl+T）共用的单一实现，
// 平移自旧版 ui/settings/index.js 的 saveUiPrefs / applyAppearance / applyHostAppearance。
import { useAppStore } from "./store";

const UI_PREF_KEY = "omp-ui-settings";

// 字体选项：外观页字体下拉与 applyAppearance 共用
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

// 外观偏好落盘（localStorage）
export function saveUiPrefs(): void {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify(useAppStore.getState().uiPrefs));
  } catch {}
}

// 外观偏好 → documentElement CSS 变量与 dataset 开关
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

// 宿主设置中纯外观副作用部分：仅 hideThinkingBlock 影响外观——同步进 uiPrefs.showThinking
// 并落盘、应用。其余宿主字段（代理/超时/开关）由页面组件以 S.hostSettings 为数据源受控渲染。
export function applyHostAppearance(hostSettings: { hideThinkingBlock?: unknown } | null | undefined): void {
  if (!hostSettings || typeof hostSettings.hideThinkingBlock !== "boolean") return;
  const showThinking = !hostSettings.hideThinkingBlock;
  // 写换新对象（selector 组件按引用感知）+ _v bump（旧 useStore 订阅兜底）
  useAppStore.setState(st => ({ uiPrefs: { ...st.uiPrefs, showThinking } }));
  saveUiPrefs();
  applyAppearance();
}
