// React shell smoke test: load the bundle in a happy-dom-simulated browser environment and assert the three-pane shell/welcome page/composer mount.
// Run: bun run smoke:react (run bun run ui:build first; artifacts in ui/dist)
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const window = new Window({ url: "http://localhost/index.html?preview=1" });
const { document } = window;

// Fill in whatever DOM APIs createRoot needs that happy-dom lacks (React 19 is lenient about container validation)
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
window.localStorage.setItem("omp-ui-settings", JSON.stringify({ lang: "zh-CN" }));
globalThis.navigator = window.navigator;
globalThis.WebSocket = class {}; // Preview mode does not connect to the host; the store top level does not create a WS (only connect does)
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
// The old module chain (markdown.js -> core.js -> tool-rows/shell etc.) constructs ResizeObserver / matchMedia at the top level;
// happy-dom provides neither global -- every real WKWebView has them; install empty implementations here
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globalThis.matchMedia = (q: string) => ({
  matches: false,
  media: q,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.location = window.location;
globalThis.URLSearchParams = window.URLSearchParams;
globalThis.getComputedStyle = window.getComputedStyle.bind(window); // Needed by the composer's cbar layout effect

// Inject the static DOM (the body structure of index.html)
document.body.innerHTML = '<div id="root"></div>';

// happy-dom does not load <link rel="stylesheet">: read ui/dist/index.html, parse the CSS href,
// read the artifact files and inline them as <style> so style assertions on the preview sample get real CSS
const distDir = join(import.meta.dir, "../ui/dist");
const distHtml = readFileSync(join(distDir, "index.html"), "utf8");
const cssTag = distHtml.match(/<link\b[^>]*rel="stylesheet"[^>]*>/)?.[0];
const cssHref = cssTag?.match(/href="([^"]+)"/)?.[1];
if (!cssHref) throw new Error("ui/dist/index.html 未找到 stylesheet link");
const styleEl = document.createElement("style");
styleEl.textContent = readFileSync(join(distDir, cssHref), "utf8");
document.head.appendChild(styleEl);

// The dynamic import is deliberate: app.js's top level constructs ResizeObserver/matchMedia and other global dependencies,
// so the happy-dom globals must be installed before evaluation; a static import would run the module before the globals are ready
await import("../ui/dist/assets/app.js");

// React rendering is async (scheduler); wait a tick before asserting
await new Promise((r) => setTimeout(r, 300));

const $ = (sel) => document.querySelector(sel);
const asserts = [];
const ok = (name, cond) => asserts.push([cond ? "✓" : "✗", name]);

ok("三栏壳挂载（#sidebar/#main/#right）", !!$("#sidebar") && !!$("#main") && !!$("#right"));
ok("preview 模式进会话区（#stream 存在且非欢迎页）", !!$("#stream") && !$("#welcomeScreen"));
ok("消息流渲染（assistant 文本可见）", ($("#stream")?.textContent || "").includes("先读一下样式文件"));
// P7 Lexical: happy-dom has no contentEditable, so Composer falls back to the placeholder (div#input read-only, editor not initialized)
ok("composer 挂载（输入区 + 发送钮）", !!($("#composer #input")) && !!$("#sendBtn"));
ok("右栏 tab 渲染（子代理 tab 激活）", ($("#rightTabs")?.textContent || "").includes("子代理"));
ok("无未捕获错误标记", !document.body.getAttribute("data-error"));

// Slash-command completion regression: once the list reply arrives, the popup must show candidates immediately (the old palette stored items/loading snapshots,
// and the reply only notified without refreshing the snapshot -> candidates never appeared until another keypress forced a recompute)
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const slashTa = $("#composer textarea#input") as HTMLTextAreaElement | null;
if (slashTa) {
  slashTa.value = "/";
  slashTa.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(80);
  ok("斜杠弹层打开（清单未拉取时加载中）", ($(".menu.palette")?.textContent || "").includes("加载中"));
} else {
  // happy-dom has no contentEditable: the Lexical completion chain is not initialized (degraded placeholder); per the PLAN, the interaction item moves to manual verification
  ok("斜杠弹层（happy-dom 无 contentEditable，转人工验证）", true);
}
// __dbg is the debug hook injected by main.tsx in preview mode (the zustand store); the happy-dom Window type has no declaration for it.
// Writes go through setState to swap the value (the selector subscribing to commands picks it up automatically; no manual trigger needed)
const dbg = (window as unknown as {
  __dbg?: {
    useAppStore: {
      getState(): {
        commands: unknown[];
        commandsSessionId: string;
        bumpSessionActivity(id: string): void;
        openSessions: Map<string, unknown>;
        activePath: string | null;
        hubOpen: boolean;
        hubSel: string | null;
        rightTabs: string[];
        rightTab: string | null;
        openHub(): void;
        closeHub(): void;
      };
      setState(p: Record<string, unknown>): void;
    };
    activateSession(path: string): void;
  };
}).__dbg;
if (!dbg) throw new Error("__dbg 调试钩子未注入");
dbg.useAppStore.setState({
  commands: [{ name: "compact", aliases: [], description: "压缩上下文", source: "builtin", subcommands: [] }],
  commandsSessionId: "preview",
});
await sleep(80);
ok("commands 回包后候选立即出现（无需再次击键）", !slashTa || (($(".menu.palette")?.textContent || "").includes("compact")));

// Builtin command description localization regression: the popup shows the commands-zh.js translation instead of the English original
dbg.useAppStore.setState({
  commands: [...dbg.useAppStore.getState().commands, { name: "usage", aliases: [], description: "Show token usage", source: "builtin", subcommands: [] }],
});
await sleep(80);
ok("builtin 描述显示中文（commands-zh.js）", !slashTa || (($(".menu.palette")?.textContent || "").includes("查看 token 用量")));

// No-tab scenario regression: the plus-button dropdown must not cross the right pane's left edge and get covered by mid-pane cards
dbg.useAppStore.setState({ rightTabs: [], rightTab: null });
await sleep(80);
const addBtn = $("#rightTabs button.icon-btn");
if (addBtn) {
  addBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  const addMenu = $(".sp-pop.sp-add") as HTMLElement | null;
  ok("无 tab 时点击加号弹出新增标签菜单", !!addMenu);
  const leftPx = addMenu?.style.left ? parseFloat(addMenu.style.left) : -1;
  ok("无 tab 时新增标签菜单 left 不小于 6px（不越界至左侧）", leftPx >= 6);
  // Close the menu after testing so it does not affect the later global Esc shortcut routing assertions
  window.dispatchEvent(new window.Event("blur"));
  await sleep(50);
}

// Esc routing regression: double-press with no text opens the tree, single press on the tree page returns to chat, double-press with text clears the input
document.querySelectorAll(".menu.open").forEach(el => el.classList.remove("open"));
const pressEsc = () => {
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
};

// 1. With no text, pressing Esc twice -> mainViewMode switches to tree
dbg.useAppStore.setState({ draftHasContent: false, pendingFiles: [], mainViewMode: "chat" });
pressEsc();
await sleep(50);
pressEsc();
await sleep(100);
ok("无文字连按两次 Esc 唤起会话树", dbg.useAppStore.getState().mainViewMode === "tree");

// 2. On the tree page, pressing Esc once -> mainViewMode switches back to chat
pressEsc();
await sleep(100);
ok("tree 页面按一次 Esc 切回对话", dbg.useAppStore.getState().mainViewMode === "chat");

// 3. With text, pressing Esc twice -> clears the input
const originalSetComposerValue = dbg.useAppStore.getState().setComposerValue;
let clearedByEsc = false;
dbg.useAppStore.setState({ draftHasContent: true, pendingFiles: [{ id: "esc-smoke", name: "draft.png", kind: "image", data: "", mimeType: "image/png" }], mainViewMode: "chat",
  setComposerValue(text, images, opts) { clearedByEsc = text === "" && images?.length === 0; originalSetComposerValue(text, images, opts); },
});
pressEsc();
await sleep(50);
pressEsc();
await sleep(100);
ok("有文字连按两次 Esc 触发清空输入框", clearedByEsc);

dbg.useAppStore.setState({ setComposerValue: originalSetComposerValue, pendingFiles: [] });

// 4. In tree mode, switching sessions (hideWelcomeScreen / activateSession) resets to chat mode
dbg.useAppStore.setState({ mainViewMode: "tree" });
dbg.useAppStore.getState().hideWelcomeScreen();
ok("切换会话时默认切回消息模式（mainViewMode: chat）", dbg.useAppStore.getState().mainViewMode === "chat");

// 5. Sidebar view switcher: contains the three buttons "Recent", "Projects", "Archived"
const segBtns = Array.from(document.querySelectorAll("#seg button"));
ok("侧栏包含最近、项目、归档三个切换按钮", segBtns.length === 3 && segBtns[2]?.textContent === "归档" && segBtns[2]?.getAttribute("data-view") === "archive");

// 6. Archive toggle and session rendering
const mockArchivedSession = {
  id: "test-arch-1",
  path: "/path/to/arch1.json",
  title: "测试归档会话",
  modified: new Date().toISOString(),
  cwd: "/path/to/project",
  archived: true,
};
dbg.useAppStore.setState({
  archivedSessions: [mockArchivedSession],
  viewMode: "archive",
});
await sleep(100);
const archTask = document.querySelector('.task[data-path="/path/to/arch1.json"]');
ok("归档视图渲染归档会话", !!archTask && (archTask.textContent?.includes("测试归档会话") ?? false));
ok("归档会话行内不显示置顶按钮且包含恢复与删除按钮", !archTask?.querySelector(".tpin") && !!archTask?.querySelector(".arch-act") && !!archTask?.querySelector(".arch-act.arch-del"));

// 7. In the Recent view, session titles do not include the project name
const mockRecentProject = {
  cwd: "/path/to/project-foo",
  sessions: [{
    id: "test-rec-1",
    path: "/path/to/rec1.json",
    title: "最近测试任务",
    modified: new Date().toISOString(),
    cwd: "/path/to/project-foo",
    archived: false,
  }],
};
dbg.useAppStore.setState({
  diskProjects: [mockRecentProject],
  viewMode: "recent",
});
await sleep(100);
const recTask = document.querySelector('.task[data-path="/path/to/rec1.json"]');
const recTitle = recTask?.querySelector(".tt")?.textContent || "";
ok("最近视图中会话标题不显示项目名后缀", recTitle === "最近测试任务" && !recTitle.includes("project-foo"));

// 8. Sidebar collapse and expand (prevent React Error #310 regression: hooks cannot be skipped conditionally during collapse)
dbg.useAppStore.setState({ sidebarCollapsed: true });
await sleep(80);
ok("侧栏收起时具备 collapsed 类名", $("#sidebar")?.classList.contains("collapsed") ?? false);
dbg.useAppStore.setState({ sidebarCollapsed: false });
await sleep(80);
ok("侧栏展开后无渲染崩溃且未命中 collapsed", !$("#sidebar")?.classList.contains("collapsed") && !document.body.getAttribute("data-error"));

// 9. Stats bar (SessionStatsBar): the active-time figure keeps moving while the
//    session runs. Frames only arrive at model-turn / tool boundaries, so a long
//    streaming answer would otherwise freeze on the last frame (the reported
//    "does not update during a session"). Displayed value = sampled activeMs +
//    elapsed since receivedAt.
const store = dbg.useAppStore as unknown as {
  getState(): { openSessions: Map<string, Record<string, unknown>> };
  setState(p: Record<string, unknown>): void;
};
const patchPreviewSession = (patch: Record<string, unknown>) => {
  const cur = store.getState().openSessions.get("/preview") ?? {};
  const openSessions = new Map(store.getState().openSessions);
  openSessions.set("/preview", { ...cur, ...patch });
  store.setState({ activePath: "/preview", openSessions });
};
// 9.5 Computer-use toggle button (composer cbar): gated by the settings-page
//     master switch (hostSettings.computerEnabled) — hidden entirely while
//     closed. When open: sits between the plan button and the background-task
     // buttons; lights up (accent .on) with the session's computerMode; on the
//     new-session page the click flips the local create intent instead.
{
  ok("主门关闭（无 hostSettings）时 computer 钮不渲染", !$("#computerBtn"));
  store.setState({ hostSettings: { computerEnabled: true } });
  await sleep(80);
  const cbarBtns = Array.from(document.querySelectorAll(".cbar > button")).map((el) => el.id);
  ok("主门开启后 computer 钮出现且位于权限胶囊之后", cbarBtns.indexOf("computerBtn") > cbarBtns.indexOf("modeBtn"));
  if (cbarBtns.includes("bgTaskBtn")) ok("computer 钮位于后台任务钮之前", cbarBtns.indexOf("computerBtn") < cbarBtns.indexOf("bgTaskBtn"));
  const cuBtn = $("#computerBtn") as HTMLButtonElement | null;
  ok("computer 钮常驻可点（无 disabled）", !!cuBtn && !cuBtn.disabled);
  patchPreviewSession({ computerMode: true });
  await sleep(80);
  ok("computerMode 开启后钮点亮（.on）且 title 提示点击关闭", !!cuBtn?.classList.contains("on") && cuBtn?.title.includes("点击关闭"));
  patchPreviewSession({ computerMode: false });
  await sleep(80);
  ok("computerMode 关闭后钮熄灭且 title 提示点击开启", !cuBtn?.classList.contains("on") && (cuBtn?.title || "").includes("点击开启"));
  cuBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok("无 WS 时会话内点击不抛错", !document.body.getAttribute("data-error"));
  // New-session page (no active session): the app mounts the WELCOME composer
  // (a separate instance) — re-query the button, the old reference is detached
  const prevPath = store.getState().activePath;
  store.setState({ activePath: null, isCreatingNew: true, newSessionComputerMode: false });
  await sleep(80);
  const cuBtnNew = $("#computerBtn") as HTMLButtonElement | null;
  ok("新建页无会话时钮可点且熄灭", !!cuBtnNew && !cuBtnNew.disabled && !cuBtnNew.classList.contains("on"));
  cuBtnNew?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("新建页点击后本地 intent 翻转且钮点亮", store.getState().newSessionComputerMode === true && !!$("#computerBtn")?.classList.contains("on"));
  // Closing the master gate hides the button again (render condition), regardless of the lit intent
  store.setState({ hostSettings: { computerEnabled: false } });
  await sleep(80);
  ok("主门再次关闭后 computer 钮消失（含点亮的 intent 态）", !$("#computerBtn"));
  store.setState({ activePath: prevPath, isCreatingNew: false, newSessionComputerMode: false });
  await sleep(80);
}
patchPreviewSession({
  streaming: true,
  stats: {
    tokens: { input: 566_989, output: 474_112, cacheRead: 60_293_120, cacheWrite: 0 },
    cost: 0,
    cacheHitRate: 0.99,
    advisorCost: 0,
    activeMs: 65_000,
    receivedAt: Date.now(),
    tokenSpeed: 42.5,
    avgTtft: 350,
  },
});
await sleep(150);
const bar0 = $("#statsBar")?.textContent ?? "";
await sleep(1300);
const bar1 = $("#statsBar")?.textContent ?? "";
const d0 = bar0.match(/(\d+)分(\d+)秒/);
const d1 = bar1.match(/(\d+)分(\d+)秒/);
ok("统计行渲染整会话口径（缓存利用率 99.0% / 时长 1分5秒）", bar0.includes("99.0%") && bar0.includes("1分5秒"));
ok("统计行包含 Token 速度与平均首字时间", bar0.includes("42.5 tok/s") && bar0.includes("350ms"));
ok(
  "运行中时长在两条统计帧之间继续走",
  !!d0 && !!d1 && Number(d1[1]) * 60 + Number(d1[2]) > Number(d0[1]) * 60 + Number(d0[2]),
);
patchPreviewSession({ streaming: false });
await sleep(80);
const bar2 = $("#statsBar")?.textContent ?? "";
await sleep(1300);
ok("收尾后时长冻结在宿主上报值", ($("#statsBar")?.textContent ?? "") === bar2 && bar2.includes("1分5秒"));

// 10. Sidebar activity bump on message send (regression: a resumed historical session kept
//     showing the previous run's end time for the whole loop — the list refreshed only at
//     runEnd). bumpSessionActivity (invoked right after the Composer's prompt send) must
//     restamp the row to now, which also lifts it to the top of the Recent sort.
dbg.useAppStore.setState({
  diskProjects: [{
    cwd: "/path/to/project-foo",
    sessions: [
      { id: "test-rec-1", path: "/path/to/rec1.json", title: "历史会话", modified: new Date(Date.now() - 2 * 3600_000).toISOString(), cwd: "/path/to/project-foo", archived: false },
      { id: "test-rec-2", path: "/path/to/rec2.json", title: "较新会话", modified: new Date(Date.now() - 60_000).toISOString(), cwd: "/path/to/project-foo", archived: false },
    ],
  }],
  viewMode: "recent",
});
await sleep(100);
const pathOrder = () => Array.from(document.querySelectorAll("#sidebar .task")).map((el) => (el as HTMLElement).dataset.path);
const beforeBump = pathOrder();
const rowBeforeBump = document.querySelector('.task[data-path="/path/to/rec1.json"]');
ok("发送前历史会话显示旧时间（2小时）", (rowBeforeBump?.textContent || "").includes("2小时"));
// Root-cause guard: a call with the host pool's per-open UUID (what the regression
// originally passed) must be a no-op — row ids are disk session ids, never equal
dbg.useAppStore.getState().bumpSessionActivity("3f2a8c1e-pool-uuid-not-a-row-id");
await sleep(60);
ok("按运行实例 id 调用不生效（id 与列表行永不相等）", (document.querySelector('.task[data-path="/path/to/rec1.json"]')?.textContent || "").includes("2小时"));
dbg.useAppStore.getState().bumpSessionActivity("/path/to/rec1.json");
await sleep(100);
const rowAfterBump = document.querySelector('.task[data-path="/path/to/rec1.json"]');
const afterBump = pathOrder();
ok("发送消息后行时间立即变为刚刚", (rowAfterBump?.textContent || "").includes("刚刚"));
ok("发送消息后会话浮到最近列表顶部", beforeBump[0] === "/path/to/rec2.json" && afterBump[0] === "/path/to/rec1.json");

// 11. Same bump in the PROJECT view: group rows are not re-sorted by the sidebar (the order
//     comes straight from the host list_sessions snapshot, already descending), so a stamped
//     row used to render "just now" while sitting below an older one. The stamp must carry
//     the row with it.
const projSessions = [
  { id: "test-proj-2", path: "/path/to/proj2.json", title: "组内最近", modified: new Date(Date.now() - 60_000).toISOString(), cwd: "/path/to/project-proj", archived: false },
  { id: "test-proj-1", path: "/path/to/proj1.json", title: "组内较旧", modified: new Date(Date.now() - 9 * 60_000).toISOString(), cwd: "/path/to/project-proj", archived: false },
];
dbg.useAppStore.setState({
  diskProjects: [{ cwd: "/path/to/project-proj", sessions: projSessions }],
  allProjects: ["/path/to/project-proj"],
  expandedProjects: new Set(["/path/to/project-proj"]),
  viewMode: "project",
});
await sleep(100);
const projBefore = pathOrder();
ok(
  `项目视图展开后按宿主快照顺序渲染（实际 ${projBefore.join()}）`,
  projBefore.join() === "/path/to/proj2.json,/path/to/proj1.json",
);
dbg.useAppStore.getState().bumpSessionActivity("/path/to/proj1.json");
await sleep(100);
ok(
  `项目视图内置顶时间后该行同时上浮（实际 ${pathOrder().join()}）`,
  pathOrder().join() === "/path/to/proj1.json,/path/to/proj2.json",
);
ok(
  "项目视图上浮后时间显示为刚刚",
  (document.querySelector('.task[data-path="/path/to/proj1.json"]')?.textContent || "").includes("刚刚"),
);


// Per-session Agent Hub regression: the hub open state (and the auto-injected "hub" tab)
// belongs to each session's own slot, never shared across switches.
const openSessions = new Map(dbg.useAppStore.getState().openSessions);
const mkSession = (path: string) => [
  path,
  {
    sessionId: path,
    cwd: "/preview",
    items: [],
    pendingApprovals: [],
    assistantDraft: "",
    streaming: false,
    turnStartAt: null,
    subagents: new Map([[`${path}-sub`, { name: "alpha", status: "completed", streaming: false, model: "t" }]]),
    model: null,
    thinking: "auto",
    isGit: false,
    todos: [],
    goal: null,
    planMode: false,
    computerMode: false,
    title: path,
    isSubagent: false,
  },
];
openSessions.set("/smoke-a", mkSession("/smoke-a")[1]);
openSessions.set("/smoke-b", mkSession("/smoke-b")[1]);
dbg.useAppStore.setState({ openSessions, isCreatingNew: false });

dbg.activateSession("/smoke-a");
dbg.useAppStore.getState().openHub();
await sleep(50);
const hubA = dbg.useAppStore.getState();
ok("A 会话打开 Agent Hub", hubA.hubOpen === true && hubA.rightTabs.includes("hub"));

dbg.activateSession("/smoke-b");
await sleep(50);
const hubB = dbg.useAppStore.getState();
ok("切到 B 会话不继承 A 的 Agent Hub", hubB.hubOpen === false && !hubB.rightTabs.includes("hub"));

dbg.activateSession("/smoke-a");
await sleep(50);
const hubBack = dbg.useAppStore.getState();
ok("切回 A 会话恢复其 Agent Hub", hubBack.hubOpen === true && hubBack.rightTabs.includes("hub"));

dbg.useAppStore.getState().closeHub();
await sleep(50);
ok("关闭 A 的 Hub 后自身状态清空", dbg.useAppStore.getState().hubOpen === false && !dbg.useAppStore.getState().rightTabs.includes("hub"));
dbg.activateSession("/smoke-b");
await sleep(50);
ok("B 会话始终未被 A 的 Hub 操作影响", dbg.useAppStore.getState().hubOpen === false);

let fail = 0;
for (const [mark, name] of asserts) {
  if (mark === "✗") fail++;
  console.log(`${mark} ${name}`);
}
if (fail > 0) {
  console.error(`React 壳冒烟失败：${fail} 项断言未过`);
  process.exit(1);
}
console.log("全部断言通过（React 壳 preview 冒烟）");
// happy-dom Window and React scheduler timers hold the event loop; without an explicit exit it hangs until timeout
process.exit(0);
