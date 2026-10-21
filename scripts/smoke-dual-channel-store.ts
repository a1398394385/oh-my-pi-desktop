// Store-level smoke: cross-channel frame landing in the frontend store.
// Complements smoke-dual-channel.ts (wire-level, two ws connections): that one proves the
// host broadcasts; this one proves the receiving store draws the right state from those
// frames — the other channel's prompt bubble, and the session_finished unread dot.
// Dynamic imports are required (not style): ui-smoke-env.ts must install the happy-dom
// globals BEFORE the store modules evaluate — same pattern as smoke-remote-layout.ts.
// Usage: bun scripts/smoke-dual-channel-store.ts
import assert from "node:assert/strict";
import "./ui-smoke-env.ts";
import { createSmokeWindow } from "./ui-smoke-env.ts";
createSmokeWindow();
const { initI18n } = await import("../ui-src/i18n");
initI18n("zh-CN");
const { useAppStore } = await import("../ui-src/store");
const { applyEvent } = await import("../ui-src/store/session.ts");
const { sessionHandlers } = await import("../ui-src/store/wsHandlers/session.ts");
const { sessionLabel } = await import("../ui-src/components/main/sidebar/util.ts");
const { t } = await import("../ui-src/i18n");
import type { OpenSession } from "../ui-src/types/session";

function seedSession(sessionId: string): OpenSession {
  return {
    sessionId, cwd: "/tmp", items: [], pendingApprovals: [], assistantDraft: "",
    streaming: false, turnStartAt: null, subagents: new Map(), model: null, thinking: "auto",
    isGit: false, todos: [], goal: null, planMode: false, computerMode: false, title: null,
    isSubagent: false,
  } as OpenSession;
}

const PATH_A = "/tmp/dual-store-a";
const finished = sessionHandlers.session_finished;

// 1. user_message (the OTHER channel's prompt): bubble + running state
useAppStore.setState((s) => ({ openSessions: new Map(s.openSessions).set(PATH_A, seedSession("s1")) }));
applyEvent({ type: "event", sessionId: "s1", kind: "user_message", text: "对端消息" });
let sess = useAppStore.getState().openSessions.get(PATH_A)!;
assert.equal(sess.items.length, 1, "user_message 插入一条气泡");
assert.equal(sess.items[0].role, "user");
assert.equal(sess.items[0].text, "对端消息");
assert.equal(sess.streaming, true, "user_message 点亮进行中状态(时钟/停止键随起)");

// images ride along (cross-channel image prompt keeps its thumbnails)
applyEvent({ type: "event", sessionId: "s1", kind: "user_message", text: "带图", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
sess = useAppStore.getState().openSessions.get(PATH_A)!;
assert.equal(sess.items.length, 2, "第二条消息独立成泡");
const imgItem = sess.items[1] as { images?: unknown[] };
assert.ok(Array.isArray(imgItem.images) && imgItem.images.length === 1, "图片附件随帧透传");

// 2. run end seals the channel's view and lights the unread dot (activePath null = not viewed)
applyEvent({ type: "event", sessionId: "s1", kind: "turn_end", runEnd: true, usage: null });
sess = useAppStore.getState().openSessions.get(PATH_A)!;
assert.equal(sess.streaming, false, "turn_end runEnd 关闭进行中");
assert.ok(useAppStore.getState().unseenFinished.has(PATH_A), "非活跃会话完成 → 本端未读点亮");

// 3. session_finished handler: unattached session still lights the dot, idempotent on repeat
finished({ type: "session_finished", sessionId: "s9", path: "/tmp/dual-store-b" });
assert.ok(useAppStore.getState().unseenFinished.has("/tmp/dual-store-b"), "未 attach 通道收到 session_finished 也点亮未读点");
const before = useAppStore.getState().unseenFinished.size;
finished({ type: "session_finished", sessionId: "s9", path: "/tmp/dual-store-b" });
assert.equal(useAppStore.getState().unseenFinished.size, before, "session_finished 幂等(add 集合不膨胀)");

// 4. active session never lights its own dot (fresh path, never lit before)
const PATH_C = "/tmp/dual-store-c";
useAppStore.setState((s) => ({ activePath: PATH_C, openSessions: new Map(s.openSessions).set(PATH_C, seedSession("s3")) }));
finished({ type: "session_finished", sessionId: "s3", path: PATH_C });
assert.ok(!useAppStore.getState().unseenFinished.has(PATH_C), "正在查看的会话不点亮未读(完成标识只在没盯着的一端/后台亮)");

// 5. session_title_changed lands on the DISK row through the open slot's path: the frame carries
// the pool UUID while the row carries the disk session id (they never coincide), so an id-only
// match left the sidebar row on its stale title until the next full list refetch.
const titleHandler = sessionHandlers.session_title_changed as unknown as (msg: {
  type: string;
  sessionId: string;
  title: string;
}) => void;
const PATH_D = "/tmp/dual-store-title-d";
const DISK_ID = "disk-session-id-d";
useAppStore.setState((s) => ({
  openSessions: new Map(s.openSessions).set(PATH_D, seedSession("pool-uuid-d")),
  diskProjects: [
    {
      cwd: "/tmp",
      sessions: [
        { id: DISK_ID, path: PATH_D, title: null, firstMessage: "(no messages)", modified: "2026-10-21T00:00:00.000Z", messageCount: 0, archived: false },
        { id: "pool-uuid-pending", path: "/tmp/dual-store-title-pending", title: null, firstMessage: "", modified: "2026-10-21T00:00:00.000Z", messageCount: 0, archived: false, pending: true },
      ],
    },
  ],
}));
titleHandler({ type: "session_title_changed", sessionId: "pool-uuid-d", title: "新标题" });
const rows = useAppStore.getState().diskProjects[0].sessions;
assert.equal(rows[0].title, "新标题", "池 UUID 的标题帧按 path 落到磁盘行");
assert.equal(rows[1].title, null, "别的行不受影响");
titleHandler({ type: "session_title_changed", sessionId: "pool-uuid-pending", title: "待落盘标题" });
assert.equal(useAppStore.getState().diskProjects[0].sessions[1].title, "待落盘标题", "pending 行仍按池 UUID 命中");

// 6. The base's "(no messages)" sentinel is not a title: the row falls back to the empty-session copy
assert.equal(sessionLabel({ title: null, firstMessage: "(no messages)" }), t("sidebar.emptySession"), "哨兵字符串不作为标题显示");
assert.equal(sessionLabel({ title: null, firstMessage: "真实首条消息" }), "真实首条消息", "真实首条消息仍是标题回退");

console.log("store 级双通道落点冒烟通过: 13 项断言");
