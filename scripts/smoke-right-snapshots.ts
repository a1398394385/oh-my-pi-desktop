// Snapshot migration regression: exercise persisted layouts through the public restore operation.
import { createSmokeWindow } from "./ui-smoke-env";
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const detail = { path: "/test/file.ts", text: "retained content", image: false };
const cases = [
  { path: "/mixed", tabs: ["file", "sessiontree", "gitdiff", "tree"], active: "sessiontree", expected: "gitdiff" },
  { path: "/last", tabs: ["file", "tree", "sessiontree"], active: "sessiontree", expected: "tree" },
  { path: "/only", tabs: ["sessiontree"], active: "sessiontree", expected: null },
  { path: "/keep", tabs: ["sessiontree", "file", "tree"], active: "tree", expected: "tree" },
  { path: "/start", tabs: ["file", "sessiontree"], active: null, expected: null },
];
localStorage.setItem("omp-right-snapshots", JSON.stringify(cases.map(c => [c.path, {
  rightTabs: c.tabs, rightTab: c.active, rightRecentClosed: [{ name: "file", at: 22 }, { name: "sessiontree", at: 21 }, { name: "tree", at: 20 }],
  selectedFile: detail.path, fileView: detail, rightCollapsed: false,
}])));
const { useAppStore } = await import("../ui-src/store");
const { restoreRightPanel, saveRightSnapshot } = await import("../ui-src/store/right");
const { initI18n, t } = await import("../ui-src/i18n");
await initI18n();
const { onMessage } = await import("../ui-src/store/ws");
onMessage({ type: "session_created", sessionId: "snapshot-smoke", path: "/test/render", cwd: "/test", model: null, thinking: "auto", isGit: true });
const { default: RightPanel } = await import("../ui-src/components/main/right/RightPanel");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
for (const c of cases) {
  useAppStore.setState({ mainViewMode: "chat", selectedSubagent: "old", fileViewPending: "/old", briefDiffPending: "/old" });
  restoreRightPanel(c.path);
  const s = useAppStore.getState();
  assert.deepEqual(s.rightTabs, c.tabs.filter(t => t !== "sessiontree"));
  assert.equal(s.rightTab, c.expected);
  assert.deepEqual(s.rightRecentClosed, [{ name: "file", at: 22 }, { name: "tree", at: 20 }]);
  assert.equal(s.rightCollapsed, false);
  assert.deepEqual(s.fileView, detail);
  assert.equal(s.selectedFile, detail.path);
  assert.equal(s.mainViewMode, "chat");
  assert.equal(s.selectedSubagent, null);
  assert.equal(s.fileViewPending, null);
  await act(async () => root.render(createElement(RightPanel, { collapsed: false })));
  const body = host.querySelector("#rightBody");
  assert(body?.textContent?.trim(), "迁移后右栏不能白屏");
  assert(!body.textContent.includes(t("right.noSubagents")), "旧会话树不能误显示子代理页");
  await act(async () => root.render(null));
  saveRightSnapshot(c.path);
  console.log(`✓ ${c.path}：标签迁移与其他状态保留`);
}
const { TAB_META, openRightTab } = await import("../ui-src/components/main/right/tabs");
assert(!("sessiontree" in TAB_META));
openRightTab("sessiontree");
assert(!useAppStore.getState().rightTabs.includes("sessiontree"));
openRightTab("tree");
assert.equal(useAppStore.getState().rightTab, "tree");
assert(!localStorage.getItem("omp-right-snapshots")!.includes("sessiontree"));
console.log("✓ 分支树仍可打开，旧会话树不再保存或显示");
await act(async () => root.unmount());
await window.happyDOM.abort();
process.exit(0);
