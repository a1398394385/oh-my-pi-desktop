// Provider logo smoke: the configured-provider list and the add-provider
// view must both render real brand marks at one uniform box size, with no
// glyph fallback left for providers that ship an asset.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-provider-logos.tsx
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { initI18n } = await import("../ui-src/i18n");
await initI18n("zh-CN");
const { useAppStore, setBump } = await import("../ui-src/store");
const { default: ModelPage } = await import("../ui-src/components/settings/pages/ModelPage");
const { PROV_LOGOS } = await import("../ui/prov-logos");
const LOGOS: Record<string, string> = PROV_LOGOS;

const providers = ["openai", "anthropic", "deepseek", "moonshot", "minimax-code-cn", "groq", "sakana"] as const;
useAppStore.setState({
  send: () => {},
  modelCatalog: providers.map((id) => ({
    id: `${id}/m`,
    name: "m",
    provider: id,
    kind: "chat" as const,
    enabled: true,
    context: 200000,
    vision: false,
    efforts: null,
    authSource: "cred" as const,
  })),
  selectedProvider: "openai",
  mpAddView: false,
  mpRolesView: false,
  mpCycleView: false,
  mpDetailProv: null,
  allProvidersCache: providers.map((id) => ({ id, label: id, login: false, accounts: 0 })),
});
setBump({});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

// Raster marks carry explicit width/height attributes; vector marks get their box from the
// inline style on the host span. Both are the single size source the UI ships.
const boxOf = (el: Element): [number, number] => {
  if (el.matches("img")) return [Number(el.getAttribute("width")), Number(el.getAttribute("height"))];
  const style = (el as HTMLElement).style;
  return [parseFloat(style.width), parseFloat(style.height)];
};

try {
  // Surface 1: the configured-provider list (left column of the model page)
  await act(async () => root.render(createElement(ModelPage)));
  const rows = [...host.querySelectorAll(".mp-l .pv")];
  const rowByName = new Map(rows.map((r) => [r.querySelector("span:nth-child(2)")?.textContent ?? "", r]));
  for (const id of providers) {
    const row = rowByName.get(id);
    assert(row, `已配置供应商列表应包含 ${id} 行`);
    const mark = row!.querySelector(".pv-ic, .pv-logo");
    assert(mark, `${id} 行应有 logo`);
    assert(!mark!.textContent?.trim(), `${id} 行不应回落到字符图标`);
  }
  const headMark = host.querySelector(".mp-head-tt .pv-ic, .mp-head-tt .pv-logo");
  assert(headMark, "右侧详情头应有供应商 logo");

  // Surface 2: the add-provider card grid
  await act(async () => setBump({ mpAddView: true, mpDetailProv: null }));
  const cards = [...host.querySelectorAll(".ap-card")];
  assert.equal(cards.length, providers.length + 1, `添加页应有 ${providers.length} 张供应商卡 + 1 张手动卡`);
  const marks = cards.slice(0, providers.length).map((c) => c.querySelector(".pv-ic, .pv-logo"));
  for (const m of marks) {
    assert(m, "每张供应商卡都应有 logo");
    assert(!m!.textContent?.trim(), "供应商卡不应回落到字符图标");
  }

  // Alphabetical order by card name (the trailing manual-add card stays pinned last)
  const names = cards.slice(0, providers.length).map((c) => c.querySelector(".ap-l1 span:last-child")?.textContent ?? "");
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), `添加页应按字母序排列，实际 ${names.join(" ")}`);

  // Uniform size: every provider mark occupies the same 16px box across both surfaces.
  // Scope to the three provider slots (list rows / cards / detail head); `.pv-ic` also
  // hosts the page's own quick-switch icon at a different size, which is not a logo.
  const listMarks = providers.map((id) => rowByName.get(id)!.querySelector(".pv-ic, .pv-logo")!);
  const cardMarks = cards.slice(0, providers.length).map((c) => c.querySelector(".pv-ic, .pv-logo")!);
  const measured = [...listMarks, ...cardMarks, headMark!];
  const boxes = measured.map(boxOf);
  assert.equal(boxes.length, providers.length * 2 + 1, `两处界面共应渲染 ${providers.length * 2 + 1} 个 logo`);
  for (const [w, h] of boxes) {
    assert.equal(w, 16, `logo 宽度应统一为 16，实际 ${w}`);
    assert.equal(h, 16, `logo 高度应统一为 16，实际 ${h}`);
  }

  // Coverage: the sampled providers must have real assets, not just a rendered box
  const missing = providers.filter((id) => !LOGOS[id]);
  assert.deepEqual(missing, [], `以下供应商缺 logo 素材: ${missing.join(" ")}`);

  console.log(`✓ 供应商 logo 冒烟通过：两处界面共 ${boxes.length} 个 logo 均为 16px`);
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
process.exit(0);
