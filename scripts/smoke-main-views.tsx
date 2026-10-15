// Center view lifecycle: rendered messages, tree, hub, drafts and wheel-listener ownership.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createSmokeWindow } from "./ui-smoke-env";
const window = createSmokeWindow();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { initI18n } = await import("../ui-src/i18n");
await initI18n();
const { useAppStore } = await import("../ui-src/store");
const { onMessage } = await import("../ui-src/store/ws");
const { default: MainColumn } = await import("../ui-src/components/main/MainColumn");
const { getDraft, getDraftText } = await import("../ui-src/components/composer/lexical/draft");
const fixture = process.env.OMP_UI_SESSION_FIXTURE;
const frames = fixture ? JSON.parse(readFileSync(fixture, "utf8")) : [
  { type: "session_created", sessionId: "view-smoke", path: "/test/view", cwd: "/test", model: null, thinking: "auto", isGit: false },
  { type: "messages", sessionId: "view-smoke", messages: [{ role: "user", text: "question" }, { role: "assistant", text: "answer", entryId: "leaf" }] },
  { type: "entry_tree", sessionId: "view-smoke", leafId: "leaf", roots: [{ id: "leaf", kind: "message", role: "assistant", text: "answer", children: [] }] },
];
for (const frame of frames) onMessage(frame);
const path = frames.find((f: { type: string }) => f.type === "session_created").path;
getDraft(path).text = "retained view-switch draft";
useAppStore.setState({ isCreatingNew: false });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const wheelListeners = new Set<EventListenerOrEventListenerObject>();
const originalAdd = document.addEventListener.bind(document);
const originalRemove = document.removeEventListener.bind(document);
document.addEventListener = ((type, callback, options) => {
  if (type === "wheel") wheelListeners.add(callback);
  originalAdd(type, callback, options);
}) as typeof document.addEventListener;
document.removeEventListener = ((type, callback, options) => {
  if (type === "wheel") wheelListeners.delete(callback);
  originalRemove(type, callback, options);
}) as typeof document.removeEventListener;
const patch = async (values: Parameters<typeof useAppStore.setState>[0]) => { await act(async () => useAppStore.setState(values)); };
try {
  await act(async () => root.render(createElement(MainColumn)));
  assert(host.querySelector("#stream .msg.assistant"));
  const chatWheelCount = wheelListeners.size;
  assert(chatWheelCount > 0);
  const composer = host.querySelector("#composer");
  await patch({ mainViewMode: "tree" });
  assert(host.querySelector(".stream-container"));
  assert.equal(host.querySelector("#stream"), null);
  assert.equal(wheelListeners.size, 0);
  assert.equal(host.querySelector("#composer"), composer);
  assert.equal(getDraftText(path), "retained view-switch draft");
  await patch({ mainViewMode: "chat" });
  assert(host.querySelector("#stream .msg.assistant"));
  assert.equal(wheelListeners.size, chatWheelCount);
  console.log("✓ 消息→树→消息：真实内容回到消息页，监听清理/重建，输入框与草稿保留");

  const state = useAppStore.getState();
  const session = state.openSessions.get(path)!;
  await patch({ openSessions: new Map(state.openSessions).set(path, { ...session, streaming: true, assistantDraft: "streaming-view-smoke" }) });
  assert.equal(host.querySelector(".streaming-draft")?.textContent, "streaming-view-smoke");
  await patch({ mainViewMode: "tree" });
  assert.equal(wheelListeners.size, 0);
  await patch({ mainViewMode: "chat" });
  assert.equal(host.querySelector(".streaming-draft")?.textContent, "streaming-view-smoke");
  console.log("✓ 流式输出期间切换：返回后继续显示同一流式草稿");

  await act(async () => useAppStore.getState().openHub());
  assert(host.querySelector("#agentHub"));
  assert.equal(host.querySelector("#composer"), null);
  assert.equal(wheelListeners.size, 0);
  assert(useAppStore.getState().rightTabs.includes("hub"));
  await act(async () => useAppStore.getState().closeHub());
  assert(host.querySelector("#stream"));
  assert(host.querySelector("#composer"));
  assert(!useAppStore.getState().rightTabs.includes("hub"));
  assert.equal(getDraftText(path), "retained view-switch draft");
  console.log("✓ Hub 打开/关闭：右栏联动、消息恢复与草稿保留");
} finally {
  await act(async () => root.unmount());
  assert.equal(wheelListeners.size, 0);
  document.addEventListener = originalAdd;
  document.removeEventListener = originalRemove;
  await window.happyDOM.abort();
}
console.log(fixture ? "✓ 已使用真实宿主回包进行页面切换验证" : "✓ 页面切换冒烟通过");

process.exit(0);
