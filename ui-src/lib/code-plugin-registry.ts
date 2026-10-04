// Code plugin registry: multiple codePlugin instances for different theme families.
// Each plugin holds a Shiki highlighter with a specific [light, dark] theme pair.
// The registry maps theme IDs to plugin keys, enabling per-theme code highlighting
// in the message area (MdSurface) without re-creating the plugin on every theme switch.
// Streamdown's createCodePlugin caches the highlighter internally; switching plugins
// is instant (no re-init cost), and switching back reuses the cached instance.
import { createCodePlugin } from "@streamdown/code";

// Plugin instances: each key holds a [light, dark] theme pair
export const CODE_PLUGINS = {
  default: createCodePlugin({ themes: ["light-plus", "dark-plus"] }),
  nord: createCodePlugin({ themes: ["light-plus", "nord"] }),
} as const;

export type CodePluginKey = keyof typeof CODE_PLUGINS;

// Theme ID -> plugin key mapping: determines which codePlugin to use for each theme.
// Built-in themes (dark/light) use default (dark-plus); custom themes like midnight
// use nord (softer colors).
export const THEME_PLUGIN_MAP: Record<string, CodePluginKey> = {
  dark: "default",
  light: "default",
  midnight: "nord",
};

// Resolve the active plugin key from the current theme ID (falls back to default
// when the theme is not in the map, supporting future custom themes without migration)
export function resolvePluginKey(themeId: string): CodePluginKey {
  return THEME_PLUGIN_MAP[themeId] || "default";
}
