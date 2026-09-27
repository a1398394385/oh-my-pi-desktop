// 快捷键跳转会话与视觉提示单测
// 严格验证：
// 1. 优先级：优先跳转到正在运行中的会话；如果正在运行中的会话不足 9 个，就用存在未读消息的会话来补齐。
// 2. 对应关系：数字 1~9 的顺序与左侧会话列表的顺序保持一致。

import { computeSidebarSessionShortcuts, SHORTCUT_DIGITS } from "../ui-src/components/sidebar/util";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
}

console.log("▶ 开始测试侧栏会话快捷键与数字分配映射...");

// 场景 1：普通会话、未读会话、运行中会话交错排列
{
  const sessions = [
    { path: "/p/s1", modified: "2026-09-27T10:00:00Z" }, // 0: 未读
    { path: "/p/s2", modified: "2026-09-27T09:00:00Z" }, // 1: 普通
    { path: "/p/s3", modified: "2026-09-27T08:00:00Z" }, // 2: 运行中
    { path: "/p/s4", modified: "2026-09-27T07:00:00Z" }, // 3: 运行中
    { path: "/p/s5", modified: "2026-09-27T06:00:00Z" }, // 4: 普通
    { path: "/p/s6", modified: "2026-09-27T05:00:00Z" }, // 5: 未读
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

  // 运行中有 2 个：s3, s4
  // 未读补齐有 2 个：s1, s6
  // 入选 4 个：s1, s3, s4, s6
  // 按列表物理顺序：
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

// 场景 2：运行中超过 9 个，优先取列表前 9 个运行中会话，未读不入选
{
  const sessions = Array.from({ length: 15 }, (_, i) => ({
    path: `/p/run_${i}`,
    modified: new Date(Date.now() - i * 1000).toISOString(),
  }));
  // 再加 5 个未读
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
  // 前 9 个运行中分别对应 1~9
  for (let i = 0; i < 9; i++) {
    const expectedDigit = SHORTCUT_DIGITS[i];
    assert(shortcuts.get(`/p/run_${i}`) === expectedDigit, `run_${i} 应当对应 ${expectedDigit}，实际为 ${shortcuts.get(`/p/run_${i}`)}`);
  }
  assert(!shortcuts.has("/p/run_9"), "第 10 个运行中会话不应被分配");
  assert(!shortcuts.has("/p/unread_0"), "运行中已满 9 个时，未读会话不应补齐进入");
  console.log("✓ 场景 2（运行中超过 9 个截断与未读排斥）通过");
}

// 场景 3：运行中不足 9 个，用未读补齐至满额 9 个
{
  // 3 个运行中，分布在不同位置
  // 10 个未读
  const sessions = [
    { path: "/p/u0", modified: "2026-09-27T20:00:00Z" }, // 0: 未读
    { path: "/p/r0", modified: "2026-09-27T19:00:00Z" }, // 1: 运行中
    { path: "/p/u1", modified: "2026-09-27T18:00:00Z" }, // 2: 未读
    { path: "/p/u2", modified: "2026-09-27T17:00:00Z" }, // 3: 未读
    { path: "/p/r1", modified: "2026-09-27T16:00:00Z" }, // 4: 运行中
    { path: "/p/u3", modified: "2026-09-27T15:00:00Z" }, // 5: 未读
    { path: "/p/u4", modified: "2026-09-27T14:00:00Z" }, // 6: 未读
    { path: "/p/r2", modified: "2026-09-27T13:00:00Z" }, // 7: 运行中
    { path: "/p/u5", modified: "2026-09-27T12:00:00Z" }, // 8: 未读（补齐末位）
    { path: "/p/u6", modified: "2026-09-27T11:00:00Z" }, // 9: 未读（超出补齐额度）
    { path: "/p/u7", modified: "2026-09-27T10:00:00Z" }, // 10: 未读（超出补齐额度）
    { path: "/p/u8", modified: "2026-09-27T09:00:00Z" }, // 11: 未读（超出补齐额度）
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

  // 运行中有 3 个（全部入选）；需要补齐 6 个未读（取列表前 6 个未读：u0~u5）
  // 总计 9 个：u0(0), r0(1), u1(2), u2(3), r1(4), u3(5), u4(6), r2(7), u5(8)
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

// 场景 4：项目视图下的置顶与折叠项目判定
{
  const projA = {
    cwd: "/projA",
    sessions: [
      { path: "/projA/s1", modified: "2026-09-27T10:00:00Z" }, // 置顶 + 运行中
      { path: "/projA/s2", modified: "2026-09-27T09:00:00Z" }, // 未读
    ],
  };
  const projB = {
    cwd: "/projB",
    sessions: [
      { path: "/projB/s1", modified: "2026-09-27T08:00:00Z" }, // 折叠项目中的运行中
    ],
  };

  const shortcuts = computeSidebarSessionShortcuts({
    viewMode: "project",
    diskProjects: [projA, projB],
    pinnedSessions: new Set(["/projA/s1"]),
    expandedProjects: new Set(["/projA"]), // 仅 projA 展开，projB 折叠
    projectLimits: new Map(),
    isProjectManageMode: false,
    openSessions: new Map([
      ["/projA/s1", { streaming: true }],
      ["/projB/s1", { streaming: true }],
    ]),
    unseenFinished: new Set(["/projA/s2"]),
  });

  // 置顶的 /projA/s1 在最顶端 -> 1
  // 展开项目中的 /projA/s2 -> 2
  // 折叠项目 projB 不在可见列表 -> 不分配
  assert(shortcuts.size === 2, `项目视图下可见候选应为 2，实际为 ${shortcuts.size}`);
  assert(shortcuts.get("/projA/s1") === "1");
  assert(shortcuts.get("/projA/s2") === "2");
  assert(!shortcuts.has("/projB/s1"), "折叠项目中的会话不应被分配快捷键");
  console.log("✓ 场景 4（项目视图置顶与展开过滤）通过");
}

console.log("🎉 全部测试用例均通过！");
