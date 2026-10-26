// MessagePage's concise live view (ui.prefs.agentProcessStyle === "concise"). Mounts the real page with a fake
// streaming session and asserts the process rows are hidden, the reveal toggle brings
// them back, and a finished turn renders exactly like before (no toggle, rows visible).
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-concise-live.tsx
//      STYLE=standard ... (regression guard: other styles keep the old live view)
// The dynamic imports below are required, not style: ui-smoke-env must install the DOM
// globals before the store modules evaluate.
import { strict as assert } from "node:assert";
import "./ui-smoke-env.ts";
import { createSmokeWindow } from "./ui-smoke-env.ts";

const win = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(win as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => null } };
class MockWebSocket {
  readyState = 1;
  onmessage: null | ((ev: { data: string }) => void) = null;
  send() {}
  close() { this.readyState = 3; }
}
(globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MessagePage } = await import("../ui-src/components/main/chat/MessagePage");
import type { ChatItem, OpenSession } from "../ui-src/types/session";

const PATH = "/tmp/concise-live";
const STYLE = process.env.STYLE || "concise";

function seed(streaming: boolean, items: ChatItem[]): OpenSession {
  return {
    sessionId: "s1", cwd: "/tmp", items, pendingApprovals: [], assistantDraft: "",
    streaming, turnStartAt: streaming ? Date.now() - 364_000 : null,
    workingText: "读取配置", subagents: new Map(), model: null, thinking: "auto",
    isGit: false, todos: [], title: null, isSubagent: false,
  } as unknown as OpenSession;
}

const items = [
  { role: "user", text: "改一下设置" },
  ...Array.from({ length: 3 }, (_, n) => ({ role: "tool", name: "read", toolCallId: "r" + n, args: { path: "/f" + n }, text: "" })),
  { role: "assistant", text: "第一段输出" },
  { role: "tool", name: "edit", toolCallId: "e1", args: { path: "/a.ts" }, text: "" },
  { role: "assistant", text: "第二段输出" },
] as ChatItem[];

useAppStore.setState({
  activePath: PATH,
  uiPrefs: { ...useAppStore.getState().uiPrefs, lang: "zh-CN", agentProcessStyle: STYLE as never },
  openSessions: new Map([[PATH, seed(true, items)]]),
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const toolRows = () => document.querySelectorAll("#stream .act .lbl, #stream .act.ro").length;
const outputs = () => [...document.querySelectorAll("#stream .msg.assistant .md-body, #stream .msg.assistant")].length;
const toggle = () => document.querySelector("#stream .act-more") as HTMLElement | null;

try {
  await act(async () => { root.render(createElement(MessagePage)); });

  const flow = document.querySelector("#stream .turn-flow");
  assert.ok(flow, "实时回合渲染");
  assert.ok(document.querySelector("#stream #workSec"), "工作中用时保留");
  assert.ok(document.querySelector("#stream .chat-loading-icon"), "转圈保留");
  if (STYLE !== "concise") {
    assert.ok(!flow!.className.includes("concise-live"), "非简洁风格不带 concise-live");
    assert.ok(toolRows() > 0, "非简洁风格照常显示工具行");
    assert.equal(toggle(), null, "非简洁风格没有展开按钮");
    console.log(`✓ 非简洁风格（${STYLE}）实时视图保持原状`);
    throw { done: true };
  }
  assert.ok(flow!.className.includes("concise-live"), "简洁实时流带 concise-live");
  assert.equal(toolRows(), 0, "工具行全部隐藏");
  assert.equal(document.querySelectorAll("#stream .act.ro").length, 0, "只读折叠块隐藏");
  assert.equal(outputs(), 2, "两段 output 保留");

  const btn = toggle();
  assert.ok(btn, "工作中行右侧出现展开按钮");
  assert.equal(btn!.getAttribute("title"), "展开处理过程", "收起态提示展开");
  await click(btn!);
  assert.ok(toolRows() > 0, "点击后展示处理过程");
  assert.equal(toggle()!.getAttribute("title"), "收起处理过程", "展开态提示收起");
  assert.ok(!document.querySelector("#stream .turn-flow")!.className.includes("concise-live"), "展开后不再压空行");

  await click(toggle()!);
  assert.equal(toolRows(), 0, "再次点击收起");

  // finished turn: unchanged rendering, no toggle
  await act(async () => {
    useAppStore.setState({ openSessions: new Map([[PATH, seed(false, items)]]) });
  });
  assert.ok(toolRows() > 0, "运行结束后处理过程照常显示");
  assert.equal(toggle(), null, "运行结束后没有展开按钮");

  console.log(`✓ 简洁实时视图（style=${STYLE}）：隐藏/展开/收起/结束回落全部正确`);
} catch (e) {
  if (!(e && typeof e === "object" && "done" in e)) throw e;
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
