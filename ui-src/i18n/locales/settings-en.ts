// English counterpart of settings-zh-CN.ts (same export names for the
// dictionaries). Intentionally (almost) empty: the fallback chain in
// SchemaRows is `dict[key]?.label ?? def.ui.label ?? key`, and the base
// schema's own ui.label / ui.description are already English, so an empty
// dictionary yields English text for free. Same for option labels
// (`dict[key]?.[value] ?? option.label ?? value`) and group titles.
// The one exception is composer.shape: the schema declares
// ui.options = "runtime" and SchemaRows hardcodes the option list, so the
// English labels must live here (otherwise the zh fallback strings would leak
// into the English UI).
// DARK_THEMES / LIGHT_THEMES are language-neutral id lists and are therefore
// exported only from settings-zh-CN.ts.
export const SETTINGS_EN: Record<string, { label: string; description?: string; warning?: string }> = {};

export const OPTS_EN: Record<string, Record<string, string>> = {
  "composer.shape": { "band": "Status bar (default)", "box": "Rounded box", "claude": "Claude Code style", "pi": "Pi style", "borderless": "Borderless", "rule": "Top separator", "field": "Compact field", "rail": "Accent rail" },
};

export const GROUPS_EN: Record<string, string> = {};

// The "" prefix (keys without a dot) needs a real entry: the fallback for it
// would otherwise be an empty string rather than a readable group name.
// Every other prefix is already English in the schema.
export const ADV_PREFIX_EN: Record<string, string> = {
  "": "Misc",
};
