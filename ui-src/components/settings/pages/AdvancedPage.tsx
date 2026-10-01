// 高级页：无 ui 元数据的键（底座不进面板的内部设置）按首段点号前缀动态分组照 schema 原样渲染。
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import SchemaRows from "../SchemaRows";
import { ADV_PREFIX_ZH } from "../../../i18n/locales/settings-zh-CN";
import { ADV_PREFIX_EN } from "../../../i18n/locales/settings-en";
import { PAGE_PLACEMENT } from "../placement";

// 高级页产出的段形状：只有显式 keys（无 from 展开），titleZh 已由前缀映射/回退解析
interface AdvSection {
  titleZh: string;
  keys: string[];
}

// schema 为底座 settingsSchema（store.js 未补类型，此处按其读取方式收窄：
// 仅用到每个键的 ui 元数据存在性）
type SchemaMap = Record<string, { ui?: unknown }>;

// advPrefix: language-specific prefix → group title dictionary; the "" prefix
// (dot-less keys) carries its own entry (zh fallback title / en "Misc"), so
// the fallback for unknown prefixes is simply the raw prefix string.
function buildSections(schema: SchemaMap | null | undefined, advPrefix: Record<string, string>): AdvSection[] {
  if (!schema) return [];
  // 已在某页 placement 显式列出的无 ui 键不再进高级页（避免重复渲染）
  const placed = new Set<string>();
  for (const secs of Object.values(PAGE_PLACEMENT))
    for (const s of secs) for (const k of s.keys || []) placed.add(k);
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const k of Object.keys(schema)) {
    if (schema[k].ui || placed.has(k)) continue; // 只收无 ui 且未被显式分布的键
    const dot = k.indexOf(".");
    const prefix = dot === -1 ? "" : k.slice(0, dot);
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
