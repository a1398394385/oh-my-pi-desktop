// Advanced page: keys without ui metadata (internal settings the base doesn't expose in panels)
// dynamically grouped by the first dot-prefix and rendered as-is from the schema.
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import SchemaRows from "../SchemaRows";
import { ADV_PREFIX_ZH } from "../../../i18n/locales/settings-zh-CN";
import { ADV_PREFIX_EN } from "../../../i18n/locales/settings-en";
import { PAGE_PLACEMENT, SPECIAL_KEY_PAGES } from "../placement";

// Section shape produced by the advanced page: explicit keys only (no from expansion), titleZh already resolved via the prefix map/fallback
interface AdvSection {
  titleZh: string;
  keys: string[];
}

// schema is the base settingsSchema (store.js adds no type; narrowed per how it's read:
// only the existence of each key's ui metadata matters)
type SchemaMap = Record<string, { ui?: unknown }>;

// TUI-only prefixes: every consumer of these keys lives in the base's TUI layer
// (interactive-mode / status-line-host / pi-tui renderer), which the desktop
// host never loads — editing them here has no effect, so the groups stay hidden.
// ui-carrying keys under these prefixes (statusLine.preset, tui.mouse…) are
// unaffected: they render on their placement pages, not here.
const TUI_ONLY_PREFIXES: Record<string, true> = { tui: true, statusLine: true };

// advPrefix: language-specific prefix → group title dictionary; the "" prefix
// (dot-less keys) carries its own entry (zh fallback title / en "Misc"), so
// the fallback for unknown prefixes is simply the raw prefix string.
function buildSections(schema: SchemaMap | null | undefined, advPrefix: Record<string, string>): AdvSection[] {
  if (!schema) return [];
  // Excluded: keys explicitly listed in some page's placement AND keys
  // hardcoded-rendered on a specific page (SPECIAL_KEY_PAGES — dedicated
  // graphical controls; e.g. the model page's eye-toggle / role cards /
  // ctrl+p cycle editor own enabledModels / modelRoles / cycleOrder)
  const placed = new Set<string>(Object.keys(SPECIAL_KEY_PAGES));
  for (const secs of Object.values(PAGE_PLACEMENT))
    for (const s of secs) for (const k of s.keys || []) placed.add(k);
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const k of Object.keys(schema)) {
    if (schema[k].ui || placed.has(k)) continue; // collect only ui-less keys not explicitly placed
    const dot = k.indexOf(".");
    const prefix = dot === -1 ? "" : k.slice(0, dot);
    if (TUI_ONLY_PREFIXES[prefix]) continue; // TUI-only: no effect under the desktop host
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
      order.push(prefix);
    }
    groups.get(prefix)!.push(k);
  }
  // Group order = first appearance of each prefix in the schema declaration
  // order; a missing titleZh falls back to the raw prefix
  return order.map((p) => ({
    titleZh: advPrefix[p] ?? p,
    keys: groups.get(p)!,
  }));
}

export default function AdvancedPage() {
  const { t } = useTranslation();
  const schema = useAppStore((s) => s.settingsSchema);
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const sections = buildSections(schema, lang === "zh-CN" ? ADV_PREFIX_ZH : ADV_PREFIX_EN);
  return (
    <div className="set-page" id="pg-advanced">
      <div className="set-tt">{t("settingsPage.nav.advanced")}</div>
      <SchemaRows sections={sections} />
    </div>
  );
}
