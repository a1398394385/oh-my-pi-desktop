// Level-1 role-menu flip smoke: when a role pill sits too close to the
// settings scroll area's bottom (role list taller than the viewport), the
// menu opens upward (.sel-up); with room below it keeps dropping down.
// Geometry is stubbed (happy-dom lays out nothing): controlled getBoundingClientRect
// per pill + a prototype-level offsetHeight so the menu measures 300px tall.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-model-role-flip.tsx
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// React-dependent modules below load dynamically on purpose (same as every
// smoke-*.tsx here): they must initialize only after createSmokeWindow
// installs the DOM — a static top-level import breaks rendering under happy-dom.
const { initI18n } = await import("../ui-src/i18n");
await initI18n("zh-CN");
const { useAppStore, setBump } = await import("../ui-src/store");
const { default: ModelPage } = await import("../ui-src/components/settings/pages/ModelPage");

const catalog = [
  { id: "prov/m1", name: "M1", provider: "prov", enabled: true, kind: "chat", context: null, vision: false, efforts: null, authSource: "cred" },
  { id: "prov/m2", name: "M2", provider: "prov", enabled: true, kind: "chat", context: null, vision: false, efforts: null, authSource: "cred" },
];
const mkRole = (id: string, name: string, top: number, bottom: number) => ({ id, name, top, bottom });
// pill geometry (CSS px, zoom 1): top row has 464px below it, mid row 14px, bottom row overflows
const roleRects = [mkRole("default", "Default", 100, 130), mkRole("smol", "Smol", 550, 580), mkRole("slow", "Slow", 590, 620)];
useAppStore.setState({
  modelCatalog: catalog,
  modelRoles: roleRects.map(({ id, name }) => ({ id, builtin: true, section: "chat", name, tag: null, value: null, resolved: null, resolvedName: null })),
});
setBump({ mpRolesView: true, mpAddView: false, mpCycleView: false });

// #setBody is not mounted in this smoke, so the bound falls back to document.body
const body = document.body;
body.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
// menu measures 300px in positionMenu (prototype-level: menu exists only after open)
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 300 });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const openPill = async (name: string) => {
  const row = [...host.querySelectorAll(".mp-role-row")].find((r) => r.querySelector("b")?.textContent === name);
  assert(row, `未找到角色 ${name} 的行`);
  const pill = row.querySelector<HTMLElement>(".mp-role-sel");
  assert(pill, `未找到角色 ${name} 的选择器`);
  const rect = roleRects.find((r) => r.name === name)!;
  pill.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.bottom, left: 0, right: 200, width: 200, height: rect.bottom - rect.top, x: 0, y: 0, toJSON() {} }) as DOMRect;
  await act(async () => pill.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  assert(pill.querySelector(".menu.open"), `${name} 菜单未打开`);
  return pill;
};
try {
  await act(async () => root.render(createElement(ModelPage)));
  // room below (464 >= 300): keeps dropping down
  const top = await openPill("Default");
  assert(!top.classList.contains("sel-up"), "空间充足行不应向上弹");
  console.log("Default(下方 464px):向下弹 ✓");
  // 14px below, 544 above: flips up
  const mid = await openPill("Smol");
  assert(mid.classList.contains("sel-up"), "下方不足且上方更足的行应向上弹");
  console.log("Smol(下方 14px / 上方 544px):向上弹 ✓");
  // pill itself past the bound: flips up
  const bottom = await openPill("Slow");
  assert(bottom.classList.contains("sel-up"), "溢出底界的行应向上弹");
  console.log("Slow(下方 -26px):向上弹 ✓");
  console.log("✓ 角色菜单翻转冒烟通过");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
process.exit(0);
