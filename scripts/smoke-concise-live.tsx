// Live segment of the running turn (MessagePage liveFrom + LiveProcess): the intent row
// sits above the working-time row, the rows produced since the turn's last output fold into
// the intent row's body, outputs stay unfolded, and a finished turn drops the live row.
// "concise" keeps the same folding but refuses to reveal the live segment.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-concise-live.tsx
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

const PATH = "/tmp/live-segment";

function seed(streaming: boolean, items: ChatItem[]): OpenSession {
  return {
    sessionId: "s1", cwd: "/tmp", items, pendingApprovals: [], assistantDraft: "",
    streaming, turnStartAt: streaming ? Date.now() - 364_000 : null,
    workingText: "读取配置", subagents: new Map(), model: null, thinking: "auto",
    isGit: false, todos: [], title: null, isSubagent: false,
  } as unknown as OpenSession;
}

// One segment before the output (a read) and one after it (an edit plus a read): the second
// is the live segment, so the intent row must carry a toggle and those two rows.
const items = [
  { role: "user", text: "改一下设置" },
  { role: "tool", name: "read", toolCallId: "r0", args: { path: "/f0" }, text: "" },
  { role: "assistant", text: "第一段输出" },
  { role: "tool", name: "edit", toolCallId: "e1", args: { path: "/a.ts" }, text: "" },
  { role: "tool", name: "read", toolCallId: "r1", args: { path: "/b.ts" }, text: "" },
] as ChatItem[];

useAppStore.setState({
  activePath: PATH,
  uiPrefs: { ...useAppStore.getState().uiPrefs, lang: "zh-CN", agentProcessStyle: "standard" },
  openSessions: new Map([[PATH, seed(true, items)]]),
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event));
};
const toggle = () => document.querySelector("#stream .act-more") as HTMLElement | null;
const body = () => document.querySelector("#stream .ro-body");
const workRow = () => document.querySelector("#stream #workSec");
const intentRow = () => document.querySelector("#stream .chat-loading-icon");

try {
  await act(async () => { root.render(createElement(MessagePage)); });

  // Running turn: both the intent row and the working-time row are on screen, the segment
  // before the output already folded, and the live segment sits behind the toggle.
  assert.ok(workRow(), "工作中用时保留");
  assert.ok(intentRow(), "intent 行动态图标保留");
  assert.equal(document.querySelectorAll("#stream .act.ro").length, 1, "输出前的事件折成一张卡");
  assert.ok(document.querySelector("#stream .msg.assistant"), "output 仍内联");
  assert.ok(toggle(), "实时段有展开开关");
  assert.equal(toggle()!.getAttribute("title"), "展开处理过程", "收起态提示展开");
  assert.equal(body(), null, "收起态不渲染展开体");

  await click(toggle()!);
  const open = body();
  assert.ok(open, "点击后展开实时段");
  assert.ok(open!.textContent!.includes("b.ts"), "展开体内出现读取行");
  // standard keeps edits out of the fold: the edit row is on screen, not inside the body
  assert.ok(!open!.textContent!.includes("a.ts"), "编辑行不进实时展开体");
  assert.ok(document.querySelector("#stream")!.textContent!.includes("a.ts"), "编辑行独立显示");
  assert.equal(toggle()!.getAttribute("title"), "收起处理过程", "展开态提示收起");

  await click(toggle()!);
  assert.equal(body(), null, "再次点击收起");

  // concise: same folding plus edits inside the segment; the body still opens on click
  await act(async () => {
    useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, agentProcessStyle: "concise" } }));
  });
  assert.ok(toggle(), "concise 同样提供展开开关");
  assert.ok(workRow(), "concise 仍保留工作中用时");
  // the edit moved into the (shut) segment, so it is off screen until the body opens
  assert.ok(!document.querySelector("#stream")!.textContent!.includes("a.ts"), "concise 把编辑行收进实时段");
  await click(toggle()!);
  assert.ok(body()!.textContent!.includes("a.ts"), "concise 展开后编辑行在段内");
  await click(toggle()!);
  assert.equal(body(), null, "concise 再点收起");

  // detailed: no live body and no toggle — the rows lay out inline instead
  await act(async () => {
    useAppStore.setState((s) => ({ uiPrefs: { ...s.uiPrefs, agentProcessStyle: "detailed" } }));
  });
  assert.equal(toggle(), null, "detailed 不提供展开开关");
  assert.equal(body(), null, "detailed 不渲染展开体");
  assert.ok(document.querySelector("#stream")!.textContent!.includes("b.ts"), "detailed 的读取行内联");

  // Finished turn: the live row disappears and every segment is a card
  await act(async () => {
    useAppStore.setState((s) => ({
      uiPrefs: { ...s.uiPrefs, agentProcessStyle: "standard" },
      openSessions: new Map([[PATH, seed(false, items)]]),
    }));
  });
  assert.equal(workRow(), null, "结束后工作中用时消失");
  assert.equal(toggle(), null, "结束后没有展开开关");
  assert.equal(document.querySelectorAll("#stream .act.ro").length, 2, "每段各一张卡");

  console.log("✓ 实时段：intent 行 + 展开体 + 工作行顺序正确，output 不折叠，简洁档同样可展开");
} finally {
  await act(async () => { root.unmount(); });
  win.happyDOM.close();
}
