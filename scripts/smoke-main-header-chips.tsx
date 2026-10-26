// MainHeader chips smoke: session title is followed by a project chip
// (display-only) and, for git sessions, a branch chip whose upward menu lists
// branches and sends switch_git_branch; non-git sessions show no branch chip.
// Also exercises the store's cwd routing: a git_branches frame for the active
// session's cwd lands in headerGit, git_branch_switched updates it (+toast).
// The "⋯" dropdown (SessCtxMenu) must offer the pin entry: clicking it sends
// set_session_pinned and flips the store's pinned set.
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-main-header-chips.tsx
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
const { useAppStore } = await import("../ui-src/store");
const { onMessage } = await import("../ui-src/store/ws");
const { default: MainHeader } = await import("../ui-src/components/main/MainHeader");

const sent: unknown[] = [];
useAppStore.setState({ send: (msg: unknown) => { sent.push(msg); } });

onMessage({ type: "session_created", sessionId: "s1", path: "/test/proj/s1.jsonl", cwd: "/test/proj", model: null, thinking: "auto", isGit: true });
useAppStore.setState({
  isCreatingNew: false,
  diskProjects: [{ cwd: "/test/proj", sessions: [] }],
});
useAppStore.setState((s) => {
  const sess = s.openSessions.get("/test/proj/s1.jsonl")!;
  return { openSessions: new Map(s.openSessions).set("/test/proj/s1.jsonl", { ...sess, title: "我的会话" }) };
});
onMessage({ type: "git_branches", cwd: "/test/proj", isGit: true, current: "main", branches: ["main", "dev"] });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const noop = () => {};
const chips = () => [...host.querySelectorAll(".head-chip")];
try {
  await act(async () => root.render(createElement(MainHeader, { onToggleSidebar: noop, onToggleRight: noop })));
  assert.equal(host.querySelector("#chatTitle")?.textContent, "我的会话");
  // project chip: display-only span
  const proj = chips().find((c) => c.tagName === "SPAN");
  assert(proj, "缺少项目胶囊");
  assert.equal(proj.textContent, "proj", `项目名应为 cwd 基名, got ${proj.textContent}`);
  assert(!proj.classList.contains("clickable"), "项目胶囊不应可点");
  // branch chip: button with current branch
  const branch = chips().find((c) => c.tagName === "BUTTON");
  assert(branch, "缺少分支胶囊");
  assert(branch.textContent?.includes("main"), `分支胶囊应显示 main, got ${branch.textContent}`);
  // mount-time fetch was sent
  assert(sent.some((m) => (m as { type?: string }).type === "get_git_branches" && (m as { cwd?: string }).cwd === "/test/proj"), "挂载时应拉取分支");
  // open the menu (portal to body), pick dev
  await act(async () => branch.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const menu = document.querySelector("#wbBranchMenu");
  assert(menu, "点击分支胶囊应弹出菜单");
  assert.deepEqual([...menu.querySelectorAll(".mi")].map((m) => m.textContent?.replace("✓", "")), ["main", "dev"].map((b) => b));
  await act(async () => [...menu.querySelectorAll(".mi")][1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const sw = sent.find((m) => (m as { type?: string }).type === "switch_git_branch") as { branch?: string; cwd?: string } | undefined;
  assert(sw && sw.branch === "dev" && sw.cwd === "/test/proj", `应发送 switch_git_branch dev, got ${JSON.stringify(sw)}`);
  // switched reply updates headerGit (frame path)
  await act(async () => onMessage({ type: "git_branch_switched", cwd: "/test/proj", branch: "dev" }));
  assert.equal(useAppStore.getState().headerGit?.current, "dev", "git_branch_switched 应回写 headerGit");
  assert.equal(chips().find((c) => c.tagName === "BUTTON")?.textContent?.includes("dev"), true, "分支胶囊应显示 dev");
  // "⋯" dropdown: the session menu offers the pin entry, clicking it pins the session
  const more = host.querySelector('button[title="更多"]') as HTMLButtonElement | null;
  assert(more, "顶栏应有「更多」按钮");
  await act(async () => more.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const sessMenu = document.querySelector(".ctx-menu");
  assert(sessMenu, "点击「更多」应弹出会话菜单");
  const pinItem = [...sessMenu.querySelectorAll("button")].find((b) => b.textContent === "置顶会话");
  assert(pinItem, `会话菜单应含「置顶会话」，实际 ${JSON.stringify([...sessMenu.querySelectorAll("button")].map((b) => b.textContent))}`);
  await act(async () => pinItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const pinMsg = sent.find((m) => (m as { type?: string }).type === "set_session_pinned") as { path?: string; pinned?: boolean } | undefined;
  assert(pinMsg && pinMsg.path === "/test/proj/s1.jsonl" && pinMsg.pinned === true, `应发送 set_session_pinned，got ${JSON.stringify(pinMsg)}`);
  assert(useAppStore.getState().pinnedSessions.has("/test/proj/s1.jsonl"), "置顶后 pinnedSessions 应包含该会话");
  // new session-menu entries: copy working dir path / open in file manager / mark as unread.
  // Each click closes the menu, so it is reopened per item.
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { copied = t; } }, configurable: true });
  const openSessMenu = async () => {
    await act(async () => more.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const m = document.querySelector(".ctx-menu");
    assert(m, "点击「更多」应弹出会话菜单");
    return m;
  };
  const labels = [...(await openSessMenu()).querySelectorAll("button")].map((b) => b.textContent);
  for (const label of ["复制工作目录路径", "在文件管理器中打开", "标记为未读"]) {
    assert(labels.includes(label), `会话菜单应含「${label}」，实际 ${JSON.stringify(labels)}`);
  }
  const copyItem = [...document.querySelectorAll(".ctx-menu button")].find((b) => b.textContent === "复制工作目录路径")!;
  await act(async () => copyItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  assert.equal(copied, "/test/proj", `复制工作目录路径应写入 cwd，got ${copied}`);
  const openItem = [...(await openSessMenu()).querySelectorAll("button")].find((b) => b.textContent === "在文件管理器中打开")!;
  await act(async () => openItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const folderMsg = sent.find((m) => (m as { type?: string }).type === "open_folder") as { path?: string } | undefined;
  assert(folderMsg && folderMsg.path === "/test/proj", `应发送 open_folder，got ${JSON.stringify(folderMsg)}`);
  const unreadItem = [...(await openSessMenu()).querySelectorAll("button")].find((b) => b.textContent === "标记为未读")!;
  await act(async () => unreadItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  assert(useAppStore.getState().unseenFinished.has("/test/proj/s1.jsonl"), "标记为未读后 unseenFinished 应包含该会话");
  // non-git session: no branch chip, project chip stays
  await act(async () => useAppStore.setState((s) => {
    const sess = s.openSessions.get("/test/proj/s1.jsonl")!;
    return { openSessions: new Map(s.openSessions).set("/test/proj/s1.jsonl", { ...sess, isGit: false }), headerGit: null };
  }));
  assert.equal(chips().filter((c) => c.tagName === "BUTTON").length, 0, "非 git 会话不应有分支胶囊");
  assert(chips().some((c) => c.tagName === "SPAN"), "项目胶囊应保留");
  // Sidebar rows carry no cwd of their own: the menu falls back to the project the row
  // belongs to, so the path entries stay available from the sidebar context menu too.
  await act(async () => useAppStore.setState({
    diskProjects: [{ cwd: "/test/proj", sessions: [{ id: "s1", path: "/test/proj/s1.jsonl", title: "我的会话", firstMessage: "", modified: "", messageCount: 0, archived: false }] }],
  }));
  const { default: SessCtxMenu } = await import("../ui-src/components/main/sidebar/SessCtxMenu");
  const menuHost = document.createElement("div");
  document.body.append(menuHost);
  const menuRoot = createRoot(menuHost);
  await act(async () => menuRoot.render(createElement(SessCtxMenu, {
    entry: { path: "/test/proj/s1.jsonl", id: "s1" },
    x: 10, y: 10, onClose: () => {}, onRename: () => {},
  })));
  const sidebarMenu = [...document.querySelectorAll(".ctx-menu")].pop()!;
  const sidebarLabels = [...sidebarMenu.querySelectorAll("button")].map((b) => b.textContent);
  for (const label of ["复制工作目录路径", "在文件管理器中打开"]) {
    assert(sidebarLabels.includes(label), `侧栏会话菜单应含「${label}」，实际 ${JSON.stringify(sidebarLabels)}`);
  }
  const sidebarOpen = [...sidebarMenu.querySelectorAll("button")].find((b) => b.textContent === "在文件管理器中打开")!;
  await act(async () => sidebarOpen.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const sidebarFolder = sent.filter((m) => (m as { type?: string }).type === "open_folder").pop() as { path?: string } | undefined;
  assert(sidebarFolder && sidebarFolder.path === "/test/proj", `侧栏菜单应发送 open_folder，got ${JSON.stringify(sidebarFolder)}`);
  await act(async () => menuRoot.unmount());
  console.log("✓ 顶栏胶囊冒烟通过：项目名展示、分支下拉切换、帧分流回写、非 git 隐藏、会话菜单新条目");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
process.exit(0);
