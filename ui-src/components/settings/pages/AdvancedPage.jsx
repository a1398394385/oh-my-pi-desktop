// 高级页：无 ui 元数据的键（底座不进面板的内部设置）按首段点号前缀动态分组照 schema 原样渲染。
import { S, useStore } from "../../../store.js";
import SchemaRows from "../SchemaRows.jsx";
import { ADV_PREFIX_ZH } from "../settings-zh.js";
import { PAGE_PLACEMENT } from "../placement.js";

function buildSections(schema) {
  if (!schema) return [];
  // 已在某页 placement 显式列出的无 ui 键不再进高级页（避免重复渲染）
  const placed = new Set();
  for (const secs of Object.values(PAGE_PLACEMENT))
    for (const s of secs) for (const k of s.keys || []) placed.add(k);
  const order = [];
  const groups = new Map();
  for (const k of Object.keys(schema)) {
    if (schema[k].ui || placed.has(k)) continue; // 只收无 ui 且未被显式分布的键
    const dot = k.indexOf(".");
    const prefix = dot === -1 ? "" : k.slice(0, dot);
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
      order.push(prefix);
    }
    groups.get(prefix).push(k);
  }
  // 组序 = 各前缀在 schema 声明序中的首次出现；titleZh 缺译回退前缀原文（无点号回退 杂项）
  return order.map((p) => ({
    titleZh: ADV_PREFIX_ZH[p] ?? (p === "" ? "杂项" : p),
    keys: groups.get(p),
  }));
}

export default function AdvancedPage() {
  useStore();
  const sections = buildSections(S.settingsSchema);
  return (
    <div className="set-page" id="pg-advanced">
      <div className="set-tt">高级</div>
      <SchemaRows sections={sections} />
    </div>
  );
}
