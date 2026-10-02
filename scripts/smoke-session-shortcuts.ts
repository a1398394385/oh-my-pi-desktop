// Unit test for session-jump shortcuts and visual hints
// Strictly verifies:
// 1. Priority: jump to running sessions first; if fewer than 9 are running, fill the rest with sessions that have unread messages.
// 2. Mapping: digits 1-9 follow the order of the left session list.

import { computeSidebarSessionShortcuts, SHORTCUT_DIGITS } from "../ui-src/components/sidebar/util";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
}

console.log("▶ 开始测试侧栏会话快捷键与数字分配映射...");

// Scenario 1: normal, unread, and running sessions interleaved
{
  const sessions = [
    { path: "/p/s1", modified: "2026-09-27T10:00:00Z" }, // 0: unread
    { path: "/p/s2", modified: "2026-09-27T09:00:00Z" }, // 1: normal
    { path: "/p/s3", modified: "2026-09-27T08:00:00Z" }, // 2: running
    { path: "/p/s4", modified: "2026-09-27T07:00:00Z" }, // 3: running
    { path: "/p/s5", modified: "2026-09-27T06:00:00Z" }, // 4: normal
    { path: "/p/s6", modified: "2026-09-27T05:00:00Z" }, // 5: unread
  ];

  const openSessions = new Map<string, { streaming?: boolean; items?: { role: string; running?: boolean }[] }>([
    ["/p/s3", { streaming: true }],
    ["/p/s4", { streaming: false, items: [{ role: "bash", running: true }] }],
  ]);

  const unseenFinished = new Set<string>(["/p/s1", "/p/s6"]);

  const shortcuts = computeSidebarSessionShortcuts({
    viewMode: "recent",
    diskProjects: [{ cwd: "/p", sessions }],
    pinnedSessions: new Set(),
    expandedProjects: new Set(),
    projectLimits: new Map(),
    isProjectManageMode: false,
    openSessions,
    unseenFinished,
  });

  // 2 running: s3, s4
  // 2 filled from unread: s1, s6
  // 4 selected: s1, s3, s4, s6
  // In physical list order:
  // s1 -> 1
  // s3 -> 2
  // s4 -> 3
  // s6 -> 4
  assert(shortcuts.size === 4, `候选会话数量应为 4，实际为 ${shortcuts.size}`);
  assert(shortcuts.get("/p/s1") === "1", `s1 应当对应 1，实际为 ${shortcuts.get("/p/s1")}`);
  assert(shortcuts.get("/p/s3") === "2", `s3 应当对应 2，实际为 ${shortcuts.get("/p/s3")}`);
  assert(shortcuts.get("/p/s4") === "3", `s4 应当对应 3，实际为 ${shortcuts.get("/p/s4")}`);
  assert(shortcuts.get("/p/s6") === "4", `s6 应当对应 4，实际为 ${shortcuts.get("/p/s6")}`);
  assert(!shortcuts.has("/p/s2"), "普通会话 s2 不应被分配快捷键");
  assert(!shortcuts.has("/p/s5"), "普通会话 s5 不应被分配快捷键");
  console.log("✓ 场景 1（运行中+未读混合交错排序）通过");
}

// Scenario 2: more than 9 running; take the first 9 running sessions in the list; unread never selected
{
  const sessions = Array.from({ length: 15 }, (_, i) => ({
    path: `/p/run_${i}`,
    modified: new Date(Date.now() - i * 1000).toISOString(),
  }));
  // Add 5 more unread
  const unreadSessions = Array.from({ length: 5 }, (_, i) => ({
    path: `/p/unread_${i}`,
    modified: new Date(Date.now() - (i + 20) * 1000).toISOString(),
  }));
  const allSessions = [...sessions, ...unreadSessions];

  const openSessions = new Map<string, { streaming?: boolean }>();
  for (const s of sessions) openSessions.set(s.path, { streaming: true });

  const unseenFinished = new Set<string>(unreadSessions.map((s) => s.path));

  const shortcuts = computeSidebarSessionShortcuts({
    viewMode: "recent",
    diskProjects: [{ cwd: "/p", sessions: allSessions }],
    pinnedSessions: new Set(),
    expandedProjects: new Set(),
    projectLimits: new Map(),
    isProjectManageMode: false,
    openSessions,
    unseenFinished,
  });

  assert(shortcuts.size === 9, `候选会话数量应满额 9，实际为 ${shortcuts.size}`);
  // The first 9 running map to 1-9
  for (let i = 0; i < 9; i++) {
    const expectedDigit = SHORTCUT_DIGITS[i];
    assert(shortcuts.get(`/p/run_${i}`) === expectedDigit, `run_${i} 应当对应 ${expectedDigit}，实际为 ${shortcuts.get(`/p/run_${i}`)}`);
  }
  assert(!shortcuts.has("/p/run_9"), "第 10 个运行中会话不应被分配");
  assert(!shortcuts.has("/p/unread_0"), "运行中已满 9 个时，未读会话不应补齐进入");
  console.log("✓ 场景 2（运行中超过 9 个截断与未读排斥）通过");
}

// Scenario 3: fewer than 9 running; fill up to the full 9 with unread
{
  // 3 running, at different positions
  // 10 unread
  const sessions = [
    { path: "/p/u0", modified: "2026-09-27T20:00:00Z" }, // 0: unread
    { path: "/p/r0", modified: "2026-09-27T19:00:00Z" }, // 1: running
    { path: "/p/u1", modified: "2026-09-27T18:00:00Z" }, // 2: unread
    { path: "/p/u2", modified: "2026-09-27T17:00:00Z" }, // 3: unread
    { path: "/p/r1", modified: "2026-09-27T16:00:00Z" }, // 4: running
    { path: "/p/u3", modified: "2026-09-27T15:00:00Z" }, // 5: unread
    { path: "/p/u4", modified: "2026-09-27T14:00:00Z" }, // 6: unread
    { path: "/p/r2", modified: "2026-09-27T13:00:00Z" }, // 7: running
    { path: "/p/u5", modified: "2026-09-27T12:00:00Z" }, // 8: unread (last fill slot)
    { path: "/p/u6", modified: "2026-09-27T11:00:00Z" }, // 9: unread (beyond the fill quota)
    { path: "/p/u7", modified: "2026-09-27T10:00:00Z" }, // 10: unread (beyond the fill quota)
    { path: "/p/u8", modified: "2026-09-27T09:00:00Z" }, // 11: unread (beyond the fill quota)
  ];

  const openSessions = new Map([
    ["/p/r0", { streaming: true }],
    ["/p/r1", { streaming: true }],
    ["/p/r2", { streaming: true }],
  ]);

  const unseenFinished = new Set([
    "/p/u0", "/p/u1", "/p/u2", "/p/u3", "/p/u4", "/p/u5", "/p/u6", "/p/u7", "/p/u8",
  ]);

  const shortcuts = computeSidebarSessionShortcuts({
    viewMode: "recent",
    diskProjects: [{ cwd: "/p", sessions }],
    pinnedSessions: new Set(),
    expandedProjects: new Set(),
    projectLimits: new Map(),
    isProjectManageMode: false,
    openSessions,
    unseenFinished,
  });

  // 3 running (all selected); 6 unread needed to fill (the first 6 unread in the list: u0-u5)
  // 9 in total: u0(0), r0(1), u1(2), u2(3), r1(4), u3(5), u4(6), r2(7), u5(8)
  assert(shortcuts.size === 9, `候选会话数量应为 9，实际为 ${shortcuts.size}`);
  assert(shortcuts.get("/p/u0") === "1");
  assert(shortcuts.get("/p/r0") === "2");
  assert(shortcuts.get("/p/u1") === "3");
  assert(shortcuts.get("/p/u2") === "4");
  assert(shortcuts.get("/p/r1") === "5");
  assert(shortcuts.get("/p/u3") === "6");
  assert(shortcuts.get("/p/u4") === "7");
  assert(shortcuts.get("/p/r2") === "8");
  assert(shortcuts.get("/p/u5") === "9");
  assert(!shortcuts.has("/p/u6"), "超额未读 u6 不应分配");
  assert(!shortcuts.has("/p/u7"), "超额未读 u7 不应分配");
  assert(!shortcuts.has("/p/u8"), "超额未读 u8 不应分配");
  console.log("✓ 场景 3（运行中补齐未读至 9 个且顺序一致）通过");
}

// Scenario 4: pinned and collapsed-project handling in the project view
{
  const projA = {
    cwd: "/projA",
    sessions: [
      { path: "/projA/s1", modified: "2026-09-27T10:00:00Z" }, // Pinned + running
      { path: "/projA/s2", modified: "2026-09-27T09:00:00Z" }, // Unread
    ],
  };
  const projB = {
    cwd: "/projB",
    sessions: [
      { path: "/projB/s1", modified: "2026-09-27T08:00:00Z" }, // Running inside a collapsed project
    ],
  };

  const shortcuts = computeSidebarSessionShortcuts({
    viewMode: "project",
    diskProjects: [projA, projB],
    pinnedSessions: new Set(["/projA/s1"]),
    expandedProjects: new Set(["/projA"]), // Only projA expanded, projB collapsed
    projectLimits: new Map(),
    isProjectManageMode: false,
    openSessions: new Map([
      ["/projA/s1", { streaming: true }],
      ["/projB/s1", { streaming: true }],
    ]),
    unseenFinished: new Set(["/projA/s2"]),
  });

  // Pinned /projA/s1 at the very top -> 1
  // /projA/s2 in the expanded project -> 2
  // Collapsed project projB is not in the visible list -> no slot assigned
  assert(shortcuts.size === 2, `项目视图下可见候选应为 2，实际为 ${shortcuts.size}`);
  assert(shortcuts.get("/projA/s1") === "1");
  assert(shortcuts.get("/projA/s2") === "2");
  assert(!shortcuts.has("/projB/s1"), "折叠项目中的会话不应被分配快捷键");
  console.log("✓ 场景 4（项目视图置顶与展开过滤）通过");
}

console.log("🎉 全部测试用例均通过！");
