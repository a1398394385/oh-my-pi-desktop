// Bottom dock tab/open-state smoke: the dock belongs to a terminal group (per project once
// terminals are project-shared), and the last terminal can be closed (which closes the dock).
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-bottom-term.ts
import assert from "node:assert/strict";
import type { OpenSession } from "../ui-src/types/session";
import "./ui-smoke-env.ts";
import { createSmokeWindow } from "./ui-smoke-env.ts";
createSmokeWindow();
// Static imports cannot work: ui-smoke-env must install the happy-dom globals before the
// store modules evaluate (same reason as smoke-dual-channel-store.ts).
const { useAppStore } = await import("../ui-src/store");
const { termGroupKey, bottomTabs, closeBottomTermTab, addBottomTermTab } = await import(
  "../ui-src/components/main/right/termTabs"
);

const seed = (cwd: string): OpenSession => ({
  sessionId: cwd, cwd, items: [], pendingApprovals: [], assistantDraft: "",
  streaming: false, turnStartAt: null, subagents: new Map(), model: null, thinking: "auto",
  isGit: false, todos: [], goal: null, planMode: false, computerMode: false, title: null,
  isSubagent: false,
} as OpenSession);
const A = "/tmp/bt-a";
const B = "/tmp/bt-b";
const st = useAppStore.getState();
useAppStore.setState({
  uiPrefs: { ...st.uiPrefs, terminalShared: true },
  openSessions: new Map([[A, seed(A)], [B, seed(B)]]),
  activePath: A,
});

const keyA = termGroupKey();
assert.equal(keyA, "p:" + A, "分组键按项目 cwd 切分");
const openNow = () => useAppStore.getState().bottomTermOpen[termGroupKey()] === true;

useAppStore.getState().toggleBottomTerm(keyA);
assert.equal(openNow(), true, "在 A 项目打开底栏");

useAppStore.setState({ activePath: B });
assert.equal(termGroupKey(), "p:" + B);
assert.equal(openNow(), false, "切到 B 项目后底栏不自动展开");

useAppStore.setState({ activePath: A });
assert.equal(openNow(), true, "切回 A 项目底栏仍打开");

const first = bottomTabs(keyA).active;
assert.ok(first, "A 组有活动终端");

closeBottomTermTab(keyA, first);
assert.deepEqual(bottomTabs(keyA).ids, [], "最后一个终端可以被关闭");
assert.equal(useAppStore.getState().bottomTermOpen[keyA], false, "关闭最后一个终端同时收起底栏");

addBottomTermTab(keyA);
const reopened = bottomTabs(keyA);
assert.equal(reopened.ids.length, 1);
assert.equal(reopened.active, reopened.ids[0], "重新打开后有一个新终端");
assert.notEqual(reopened.active, first, "重建的终端不复用旧 id");

// Two tabs: closing the active one falls back to the neighbour
addBottomTermTab(keyA);
const two = bottomTabs(keyA);
assert.equal(two.ids.length, 2);
const [t1, t2] = two.ids;
closeBottomTermTab(keyA, t2);
assert.deepEqual(bottomTabs(keyA), { ids: [t1], active: t1 }, "关闭活动标签回退到相邻标签");

// Reopening A's dock keeps the surviving tab; other projects keep their own switch
useAppStore.getState().toggleBottomTerm(keyA);
assert.equal(openNow(), true);
assert.deepEqual(bottomTabs(keyA).ids, [t1], "重新打开沿用在存的标签");
assert.equal(useAppStore.getState().bottomTermOpen["p:" + B], undefined, "其它项目的开关不受影响");

console.log("✓ bottom dock: 按项目隔离开关 / 最后一个终端可关闭并收起底栏");
