// Smoke: settings reclassification (2026-11). Asserts the page set, the merged page
// ownership, and the two mis-mapped keys found during the audit. Data-level only —
// the page rendering itself is checked in the dev:browser channel.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-settings-reclass.tsx
import { strict as assert } from "node:assert";

const { PAGE_PLACEMENT, HIDDEN_KEYS, STATIC_KEY_PAGE_MAP, SPECIAL_KEY_PAGES, buildKeyToPageMap } = await import(
  "../ui-src/components/settings/placement"
);

const pages = Object.keys(PAGE_PLACEMENT).sort();
// SchemaRows pages only: the custom-UI pages (stats / remote / keyboard / automations /
// extensions / experimental / advanced) declare no placement sections.
assert.deepEqual(
  pages,
  [
    "pg-agents", "pg-appearance", "pg-computer", "pg-context", "pg-developer", "pg-files",
    "pg-general", "pg-hooks", "pg-interaction", "pg-mcp", "pg-memory", "pg-model", "pg-plugins",
    "pg-services", "pg-shell", "pg-skills", "pg-tools",
  ],
  "schema 页集合 = 23 页导航去掉 6 个纯自定义页",
);

for (const gone of ["pg-model-behavior", "pg-tasks", "pg-ssh", "pg-providers", "pg-capabilities"]) {
  assert.ok(!(gone in PAGE_PLACEMENT), `${gone} 已并入且不再声明`);
}

// Merged pages own the source groups.
assert.ok(PAGE_PLACEMENT["pg-agents"].some((s) => s.from === "tasks/Modes"), "子代理页吸收任务模式");
assert.ok(PAGE_PLACEMENT["pg-services"].some((s) => s.from === "interaction/Collab"), "服务页吸收协作");
assert.ok(PAGE_PLACEMENT["pg-services"].some((s) => s.from === "interaction/Stream"), "服务页吸收推流");
assert.ok(PAGE_PLACEMENT["pg-model"].some((s) => s.from === "model/Sampling"), "模型配置页吸收采样");
assert.ok(
  PAGE_PLACEMENT["pg-interaction"].every((s) => s.from !== "interaction/Collab"),
  "交互页不再持有协作",
);

// Single-home check: the hook timeout renders on pg-hooks only, never inside the
// extensions group expansion.
const extSection = PAGE_PLACEMENT["pg-plugins"].find((s) => s.from === "tools/Extensions");
assert.ok(extSection?.excludeKeys?.includes("extensionHandlers.toolCallTimeoutMs"), "扩展组排除钩子超时键");

// Minimal schema exercising the two keys that were mis-mapped or hidden.
const schema = {
  hideThinkingBlock: { type: "boolean", ui: { tab: "model", group: "Thinking", label: "Hide" } },
  "extensionHandlers.toolCallTimeoutMs": { type: "number", ui: { tab: "tools", group: "Extensions", label: "Timeout" } },
  "marketplace.autoUpdate": { type: "boolean", ui: { tab: "interaction", group: "Startup & Updates", label: "Marketplace" } },
  "collab.relayUrl": { type: "string", ui: { tab: "interaction", group: "Collab", label: "Relay" } },
} as never;
const map = buildKeyToPageMap(schema);
assert.equal(map.hideThinkingBlock, "pg-appearance", "隐藏思考块搜索落到外观页");
assert.equal(map["extensionHandlers.toolCallTimeoutMs"], "pg-hooks", "钩子超时只在钩子页");
assert.equal(map["collab.relayUrl"], "pg-services", "协作键搜索落到服务页");
assert.equal(STATIC_KEY_PAGE_MAP["marketplace.autoUpdate"], undefined, "隐藏的市场开关不再进静态搜索表");
assert.ok(HIDDEN_KEYS["marketplace.autoUpdate"], "市场开关仍在隐藏名单");

// UI-ified advanced keys: each must be declared by exactly one page's explicit key list,
// and setupVersion must stay hidden.
const uiFied: Record<string, string> = {
  "session.warnCost": "pg-context", "session.maxCost": "pg-context",
  "branchSummary.reserveTokens": "pg-context", "compaction.modelThresholdsEnabled": "pg-context",
  "retry.enabled": "pg-model", "retry.baseDelayMs": "pg-model",
  "providers.anthropic.slowMode": "pg-services",
  "commit.cacheEnabled": "pg-general", "commit.cacheTtlDays": "pg-general",
  "commit.mapReduceEnabled": "pg-general", "commit.mapReduceThreshold": "pg-general",
  "commit.mapBatchTokenBudget": "pg-general", "commit.changelogMaxDiffChars": "pg-general",
  "shellPath": "pg-shell", "shellCommandPrefix": "pg-shell",
  "async.maxJobs": "pg-tools",
  "gc.compress": "pg-developer", "gc.compressAfterDays": "pg-developer",
};
const declaredIn = (key: string) =>
  Object.entries(PAGE_PLACEMENT)
    .filter(([, secs]) => secs.some((s) => s.keys?.includes(key)))
    .map(([page]) => page);
for (const [key, page] of Object.entries(uiFied)) {
  assert.deepEqual(declaredIn(key), [page], `${key} 只在 ${page} 声明`);
}
assert.ok(HIDDEN_KEYS.setupVersion, "setupVersion 隐藏");

// Advisor: the two switches are hand written (AdvisorSection.tsx), so the section must
// carry the id, keep the master key out of its rows, and keep the key searchable.
const advisorSection = PAGE_PLACEMENT["pg-model"].find((s) => s.id === "advisor");
assert.ok(advisorSection, "顾问段带 id 供页面自绘");
assert.ok(advisorSection.excludeKeys?.includes("advisor.enabled"), "总开关由手写行渲染，不在 SchemaRows 行里");
assert.equal(SPECIAL_KEY_PAGES["advisor.enabled"], "pg-model", "总开关搜索落模型配置页");

console.log("✓ 设置分类：23 页、合并归属、单点渲染与搜索映射正确");
