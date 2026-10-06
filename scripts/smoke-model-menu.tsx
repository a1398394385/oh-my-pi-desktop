// Controlled model menu contracts and settings-adapter behavior.
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { default: Menu } = await import("../ui-src/components/shared/models/ModelCascadeMenu");
const { ModelCascadePicker, roleAcceptsModel } = await import("../ui-src/components/settings/RolePicker");
const { initI18n } = await import("../ui-src/i18n");
await initI18n();
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const models = [{ id: "a/one", name: "One", provider: "a" }, { id: "b/two", name: "Two", provider: "b" }];
const picked: string[] = [];
const rolePicked: string[] = [];
const options = {
  models, selectedId: "a/one", onPick: (id: string) => picked.push(id),
  positionFlyout() {}, renderModelMeta: () => createElement("span", { className: "cap-b" }, "cache"),
  roles: [{ id: "fast", name: "Fast", resolved: "b/two" }], roleLabel: "Roles",
  onPickRole: (role: { id: string }) => rolePicked.push(role.id),
};
const mount = async (node: Parameters<typeof root.render>[0]) => { await act(async () => root.render(node)); };
const click = async (selector: string) => {
  const el = host.querySelector(selector);
  assert(el, `缺少 ${selector}`);
  await act(async () => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
};
await mount(createElement(Menu, options));
assert.deepEqual([...host.querySelectorAll(".prov")].map(e => e.textContent), ["Roles", "a", "b"]);
await click(".prov:nth-of-type(3)");
assert.equal(host.querySelector("[data-model='a/one'] .ck")?.textContent, "✓");
assert.equal(host.querySelectorAll("[data-model]").length, 1);
assert.equal(host.querySelector(".cap-b")?.textContent, "cache");
await click("[data-model='a/one']");
assert.deepEqual(picked, ["a/one"]);
await click(".prov:first-child");
await click("[data-role='fast']");
assert.deepEqual(rolePicked, ["fast"]);
await click(".prov:first-child");
assert.equal(host.querySelector(".flyout"), null);
console.log("✓ 候选分组、选中标记、模型/角色回调、能力插槽与二级菜单切换");

await mount(createElement(ModelCascadePicker, { models: [models[1]], label: "selected", selectedId: "b/two", onPick: id => picked.push(id) }));
await click(".sel");
assert.deepEqual([...host.querySelectorAll(".prov")].map(e => e.textContent), ["b"]);
await click(".prov");
await click("[data-model='b/two']");
assert.equal(host.querySelector(".menu"), null);
assert.equal(picked.at(-1), "b/two");
await click(".sel");
await act(async () => document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })));
assert.equal(host.querySelector(".menu"), null);
await mount(createElement(ModelCascadePicker, { models, label: "disabled", disabled: true, onPick: id => picked.push(id) }));
await click(".sel");
assert.equal(host.querySelector(".menu"), null);
await mount(createElement(Menu, { ...options, models: [], roles: [], emptyContent: createElement("div", { className: "mi empty" }, "empty") }));
assert.equal(host.querySelector(".empty")?.textContent, "empty");
assert.equal(host.querySelectorAll(".prov").length, 0);
assert(roleAcceptsModel({ id: "image", name: "Image" }, { ...models[0], enabled: true, kind: "image" }));
assert(!roleAcceptsModel({ id: "web", name: "Web" }, { ...models[0], enabled: true, kind: "chat" }));
console.log("✓ 设置候选过滤、选择后关闭、外部关闭、禁用态与空态");

await mount(createElement(Menu, options));
await click(".prov:nth-of-type(3)");
await act(async () => {
  host.querySelector(".flyout")!.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 170));
});
assert.equal(host.querySelector(".flyout"), null);
const originalSet = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
const menuTimers = new Set<ReturnType<typeof setTimeout>>();
globalThis.setTimeout = ((fn, delay, ...args) => {
  const timer = originalSet(fn, delay, ...args);
  if (delay === 180 || delay === 150) menuTimers.add(timer);
  return timer;
}) as typeof setTimeout;
globalThis.clearTimeout = ((timer) => { menuTimers.delete(timer); originalClear(timer); }) as typeof clearTimeout;
try {
  await act(async () => host.querySelectorAll(".prov")[2].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })));
  assert.equal(menuTimers.size, 1);
  await mount(null);
  assert.equal(menuTimers.size, 0);
  console.log("✓ 离开二级菜单后关闭，卸载清理悬停定时器");
} finally {
  globalThis.setTimeout = originalSet;
  globalThis.clearTimeout = originalClear;
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
