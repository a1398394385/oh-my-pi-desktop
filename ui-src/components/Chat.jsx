// 会话区：TODO 进程卡（statusWrap）+ 消息流（stream）+ 消息轨道（msgRail）+
// 「工作中 N 秒」行（WorkSec）+ 会话内查找（⌘F）。流式状态行（转圈+动态文字）在 ChatLoading。
// 迁移自 ui/chat.js renderChat + markdown.js 的滚动收尾：
// - 滚动跟随（stickBottom 语义）：切会话强制落底；贴底时任何重渲染（流式追加/展开体）
//   保持钉底。贴底判定必须在 DOM 更新前——用 scroll 监听持续记录的渲染前状态，
//   渲染后 scrollHeight 已变不可回推（120px 容差同原版）。
// - 「滚动至结尾」按钮：常驻 stream 末尾（原 ensureScrollBottom），显隐由 scroll 事件
//   命令式切换（4px 容差防亚像素抖动，高频滚动不进 React 状态）。
import { useLayoutEffect, useRef } from "react";
import { useAppStore, isJunkPlaceholder, send } from "../store";
import Icon from "../Icon.jsx";
import TodoCard from "./chat/TodoCard.jsx";
import { WorkSec } from "./chat/WorkLine.jsx";
import ChatLoading from "./chat/ChatLoading.jsx";
import MsgRail from "./chat/MsgRail.jsx";
import FindBar from "./chat/FindBar.jsx";
import AssistantMsg from "./chat/AssistantMsg.jsx";
import { renderItems } from "./chat/items.jsx";

// 按钮显隐：仅当消息流还有向下滚动余量时显示（4px 容差防亚像素抖动）
function updateScrollBottomVis(el, btn) {
  if (!el || !btn) return;
  btn.classList.toggle("hidden", !(el.scrollHeight - el.scrollTop - el.clientHeight > 4));
}

export default function Chat() {
  // 当前会话订阅：所有 session 写入走 updateSession 换引用（items/draft/streaming 变化即重渲染）
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const activePath = useAppStore((st) => st.activePath);
  const streamRef = useRef(null);
  const btnRef = useRef(null);
  const prevPath = useRef(null);
  const atBottom = useRef(true); // 渲染前的贴底状态（scroll 监听持续记录）

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    updateScrollBottomVis(el, btnRef.current);
  };

  // 切会话强制落底 + 流式期间贴近底部则跟随（useLayoutEffect 在 paint 前完成，不闪旧位置）
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !s) return;
    const switched = prevPath.current !== activePath;
    prevPath.current = activePath;
    // 切换会话时 stream 节点被复用，旧会话的 scrollTop 对新会话无意义（拿去算贴底常误判）
    if (switched || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true; // scroll 事件异步 fire，先同步落定防同帧二次渲染回弹
    }
    updateScrollBottomVis(el, btnRef.current);
  });

  // 滚动至结尾按钮（常驻末位，显隐走 scroll 监听）
  const scrollBottomBtn = (
    <button
      id="scrollBottom"
      className="scroll-bottom hidden"
      type="button"
      title="滚动到底部"
      ref={btnRef}
      onClick={() => {
        const el = streamRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }}
    >
      <Icon name="down" />
    </button>
  );

  if (!s) {
    return (
      <>
        <div id="statusWrap" />
        <div id="stream" ref={streamRef} onScroll={onScroll}>
          <div className="text-faint text-ui-base py-[12px] px-[10px]">点左侧任务或「新建任务」开始</div>
          {scrollBottomBtn}
        </div>
      </>
    );
  }

  // 消息轨道数据：渲染期随 items 遍历收集（key 与 data-fk 锚点同源）
  const railEntries = [];
  const nodes = renderItems(s.items, "", railEntries);
  return (
    <>
      <TodoCard />
      {/* 外部进程写入提示条：宿主 session_external_write 帧置位，重新加载从磁盘重建清除 */}
      {s.externalWrite && (
        <div className="extw-bar">
          <Icon name="info" />
          <span className="extw-tx">此会话正在被其他进程写入（如 CLI），视图可能不同步</span>
          <button type="button" className="save-btn" onClick={() => send({ type: "reload_session", path: activePath })}>
            重新加载
          </button>
        </div>
      )}
      <div id="stream" ref={streamRef} onScroll={onScroll}>
        {nodes}
        {(s.streaming || s.assistantDraft) && <WorkSec />}
        {/* 流式尾巴只渲染纯文本（BUG-007 三连雷）：对增长的全文每帧重跑 markdown 管线
            是 O(n²) 累积,JSC 下长回复必然烧穿主线程——定稿(turn_end push 为历史条目)
            才交给 AssistantMsg 做 markdown 解析(历史条目有 memo,只解析一次) */}
        {s.assistantDraft && !isJunkPlaceholder(s.assistantDraft) && (
          <div className="msg assistant md-body streaming-draft stream-plain">{s.assistantDraft}</div>
        )}
        {/* 流式转圈：消息流末位（对应 ZCode TurnChatLoadingSlot），紧贴输入框上方，轮结束消失 */}
        {s.streaming && <ChatLoading />}
        {scrollBottomBtn}
      </div>
      <MsgRail entries={railEntries} sessionId={s.sessionId} streamRef={streamRef} />
      <FindBar streamRef={streamRef} />
    </>
  );
}
