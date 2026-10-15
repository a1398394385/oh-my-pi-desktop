// Code plugin registry: multiple codePlugin instances for different theme families.
// Each plugin holds a Shiki highlighter with a specific [light, dark] theme pair.
// The registry maps theme IDs to plugin keys, enabling per-theme code highlighting
// in the message area (MdSurface) without re-creating the plugin on every theme switch.
// Streamdown's createCodePlugin caches the highlighter internally; switching plugins
// is instant (no re-init cost), and switching back reuses the cached instance.
import { createCodePlugin } from "@streamdown/code";
import { getThemeById } from "../theme-registry";

// Plugin instances: each key holds a [light, dark] theme pair
export const CODE_PLUGINS = {
  default: createCodePlugin({ themes: ["light-plus", "dark-plus"] }),
  nord: createCodePlugin({ themes: ["light-plus", "nord"] }),
} as const;

export type CodePluginKey = keyof typeof CODE_PLUGINS;

// Resolve the active plugin from the theme registry so new themes inherit their
// declared Shiki palette without another mapping table.
export function resolvePluginKey(themeId: string): CodePluginKey {
  return getThemeById(themeId)?.shikiTheme === "nord" ? "nord" : "default";
}
