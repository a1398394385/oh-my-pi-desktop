// Right-panel unified slot table regression: persisted layouts through the public slot
// operations, directed browser auto-open, disposal cascade, LRU cap, legacy-snapshot drop.
// Dynamic imports are deliberate: the localStorage seed below must land before the store
// modules load (right.ts reads the slot table at module scope), so static imports cannot work.
import { createSmokeWindow } from "./ui-smoke-env";
import { strict as assert } from "node:assert";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const detail = { path: "/test/file.ts", text: "retained content", image: false };

// Legacy snapshot table present at startup: dropped wholesale, never read (D1: no migration)
localStorage.setItem("omp-right-snapshots", JSON.stringify([["/legacy", { rightTabs: ["file"], rightTab: "file", rightRecentClosed: [], selectedFile: null, fileView: null, rightCollapsed: false }]]));
// New slot table: one persisted row for /kept
localStorage.setItem("omp-right-slots", JSON.stringify([["/kept", {
  tabs: ["file", "gitdiff"], active: "gitdiff", recentClosed: [{ name: "tree", at: 20 }],
  selectedFile: detail.path, fileView: detail, collapsed: false,
}]]));

const { useAppStore } = await import("../ui-src/store");
const { saveRightSlot, restoreRightSlot, disposeRightSlot, registerSlotDisposer, openTabInSlot, landBrowserTabs } = await import("../ui-src/store/right");
const { initI18n, t } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { onMessage } = await import("../ui-src/store/ws");
onMessage({ type: "session_created", sessionId: "slot-smoke", path: "/test/render", cwd: "/test", model: null, thinking: "auto", isGit: true });
const { default: RightPanel } = await import("../ui-src/components/main/right/RightPanel");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

// ---- 1. legacy table dropped: /legacy never materializes, the old key is removed
assert.equal(localStorage.getItem("omp-right-snapshots"), null, "旧快照 key 必须被清除");
restoreRightSlot("/legacy");
const s1 = useAppStore.getState();
assert.deepEqual(s1.rightTabs, []);
assert.equal(s1.rightTab, null);
console.log("✓ 旧快照表整体丢弃（不迁移）");
const tab = (name: string) => ({ name, url: "about:blank", title: "T", kind: "chromium", mirrorable: true });
useAppStore.setState({ mainViewMode: "chat", selectedSubagent: "old", fileViewPending: "/old", briefDiffPending: "/old" });
restoreRightSlot("/kept");
const s2 = useAppStore.getState();
assert.deepEqual(s2.rightTabs, ["file", "gitdiff"]);
assert.equal(s2.rightTab, "gitdiff");
assert.deepEqual(s2.rightRecentClosed, [{ name: "tree", at: 20 }]);
assert.equal(s2.rightCollapsed, false);
assert.deepEqual(s2.fileView, detail);
assert.equal(s2.selectedFile, detail.path);
assert.equal(s2.selectedSubagent, null);
assert.equal(s2.fileViewPending, null);
console.log("✓ 持久化槽恢复：布局与详情齐备、瞬态清空");

// ---- 3. restored slot renders without a blank panel
await act(async () => root.render(createElement(RightPanel, { collapsed: false })));
const body = host.querySelector("#rightBody");
assert(body, "右栏主体存在");
assert(body.textContent?.trim(), "槽恢复后右栏不能白屏");
assert(!body.textContent.includes(t("right.noSubagents")), "未选子代理时不能误显示子代理页");
console.log("✓ 右栏渲染正常");

// ---- 4. save round-trip: projection → slot → localStorage (pending views skipped)
useAppStore.setState({ rightTabs: ["tree"], rightTab: "tree", fileViewPending: "/half" });
saveRightSlot("/kept");
const persisted = JSON.parse(localStorage.getItem("omp-right-slots")!) as [string, Record<string, unknown>][];
const kept = persisted.find(([p]) => p === "/kept")![1];
assert.deepEqual(kept.tabs, ["tree"]);
assert.equal(kept.active, "tree");
assert.equal(kept.fileView, null, "pending 视图不持久化");
restoreRightSlot("/kept");
assert.equal(useAppStore.getState().fileView, null);
console.log("✓ save 往返：投影入槽、半加载视图跳过");

// ---- 5. welcome pseudo-slot: null path is one slot like any other; first open inherits
useAppStore.setState({ rightTabs: ["terminal"], rightTab: "terminal" });
saveRightSlot(null);
restoreRightSlot("/fresh");
assert.deepEqual(useAppStore.getState().rightTabs, ["terminal"], "无槽首开继承当前布局");
assert.equal(useAppStore.getState().selectedFile, null, "继承时清会话级详情");
restoreRightSlot(null);
assert.deepEqual(useAppStore.getState().rightTabs, ["terminal"], "welcome 槽恢复");
console.log("✓ welcome 伪会话槽同构（null 即 welcome）");

// ---- 6. directed auto-open: a background session's browsing lands in ITS slot
useAppStore.setState({ activePath: "/viewing", rightTabs: ["tree"], rightTab: "tree", rightCollapsed: false });
landBrowserTabs([tab("a")], true, "/bg");
assert.deepEqual(useAppStore.getState().rightTabs, ["tree"], "定向打开不动当前面板");
assert.equal(useAppStore.getState().rightTab, "tree");
restoreRightSlot("/bg");
const bg = useAppStore.getState();
assert(bg.rightTabs.includes("mirror"), "后台槽拿到 mirror tab");
assert.equal(bg.rightTab, "mirror");
assert.equal(bg.rightCollapsed, false, "auto-open 隐含展开");
console.log("✓ 定向 auto-open：镜像落在触发会话的槽");

// ---- 7. foreground semantics: owner displayed (or absent) keeps the legacy open; latch per burst
landBrowserTabs([], false); // drain: reset the burst latch consumed in step 6
landBrowserTabs([tab("a")], true, "/viewing");
assert.equal(useAppStore.getState().rightTab, "mirror", "前台 owner：照旧打开");
useAppStore.setState({ rightTab: "tree" });
landBrowserTabs([tab("a")], false);
assert.equal(useAppStore.getState().rightTab, "tree", "非激活边沿不重复打开");
landBrowserTabs([], false);
landBrowserTabs([tab("a")], true);
assert.equal(useAppStore.getState().rightTab, "mirror", "清空后 latch 复位");
console.log("✓ 前台打开与 latch 语义保持");

// ---- 8. disposal cascade: registered disposers run on slot destroy
let disposed = 0;
registerSlotDisposer("/bg", () => disposed++); // /bg's slot exists (step 6 restored it; restore keeps the slot)
disposeRightSlot("/bg");
assert.equal(disposed, 1, "disposer 必须执行");
assert(!JSON.parse(localStorage.getItem("omp-right-slots")!).some(([p]: [string]) => p === "/bg"), "槽销毁后不再持久化");
console.log("✓ 槽销毁级联回收（disposer 执行）");

// ---- 9. LRU cap: overflowing the table disposes the eldest (its disposers run)
let eldestDisposed = 0;
const first = "/fill/0";
openTabInSlot(first, "tree");
registerSlotDisposer(first, () => eldestDisposed++);
for (let i = 1; i < 40; i++) openTabInSlot(`/fill/${i}`, "tree");
assert.equal(eldestDisposed, 1, "最旧槽淘汰时 disposer 执行");
assert(!JSON.parse(localStorage.getItem("omp-right-slots")!).some(([p]: [string]) => p === first), "淘汰槽不再持久化");
console.log("✓ LRU-32 上限：最旧槽淘汰并回收");

await act(async () => root.unmount());
await window.happyDOM.abort();
process.exit(0);
