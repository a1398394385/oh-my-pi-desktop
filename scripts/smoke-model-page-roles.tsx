// RolesView row-description smoke: a role configured with a reference value
// ("@smol", written by the RolePicker reference section) must NOT show the
// "not among available models" hint, while a concrete model id missing from
// the catalog keeps it.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-model-page-roles.tsx
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
  { id: "prov/chat-m", name: "Chat M", provider: "prov", enabled: true, kind: "chat" },
  { id: "prov/vision-m", name: "Vision M", provider: "prov", enabled: true, kind: "chat", vision: true },
];
const roles = [
  // vision referencing the smol role (reference section write) — no hint
  { id: "vision", builtin: true, section: "chat", name: "Vision", tag: null, value: "@smol", resolved: "prov/chat-m", resolvedName: "Chat M" },
  // slow pointing at a concrete model absent from the catalog — hint stays
  { id: "slow", builtin: true, section: "chat", name: "Slow", tag: null, value: "ghost/gone-m", resolved: null, resolvedName: null },
];
useAppStore.setState({ modelCatalog: catalog, modelRoles: roles });
setBump({ mpRolesView: true, mpAddView: false, mpCycleView: false });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const rowText = (id: string) => {
  const rows = [...host.querySelectorAll(".mp-role-row")];
  const row = rows.find((r) => r.querySelector("b")?.textContent?.startsWith(roles.find((x) => x.id === id)!.name));
  return row?.textContent ?? "";
};
try {
  await act(async () => root.render(createElement(ModelPage)));
  const visionText = rowText("vision");
  const slowText = rowText("slow");
  assert(!visionText.includes("不在当前可用模型中"), `vision 引用值不应显示警告: ${visionText}`);
  assert(visionText.includes("图像 / 视觉理解任务"), `vision 行应显示角色描述: ${visionText}`);
  assert(slowText.includes("已配置 ghost/gone-m"), `具体模型缺目录仍应显示警告: ${slowText}`);
  console.log(`vision(@smol) 行: ${visionText}`);
  console.log(`slow(ghost/gone-m) 行: ${slowText}`);
  console.log("✓ 角色行警告冒烟通过：引用值不提示、缺目录具体模型保留提示");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
process.exit(0);
