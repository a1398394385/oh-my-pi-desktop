// 会话区：TODO 进程卡（statusWrap）+ 消息流（stream）+ 消息轨道（msgRail）+
// 「工作中 N 秒」行（WorkSec）+ 会话内查找（⌘F）。流式状态行（转圈+动态文字）在 ChatLoading。
// 迁移自 ui/chat.js renderChat + markdown.js 的滚动收尾：
// - 滚动跟随（stickBottom 语义）：切会话强制落底；贴底时任何重渲染（流式追加/展开体）
//   保持钉底。贴底判定必须在 DOM 更新前——用 scroll 监听持续记录的渲染前状态，
//   渲染后 scrollHeight 已变不可回推（120px 容差同原版）。
// - 「滚动至结尾」按钮：常驻 stream 末尾（原 ensureScrollBottom），显隐由 scroll 事件
//   命令式切换（4px 容差防亚像素抖动，高频滚动不进 React 状态）。
import { useEffect, useLayoutEffect, useRef } from "react";
import { useAppStore, isJunkPlaceholder, send } from "../store";
import Icon from "../Icon";
import TodoCard from "./chat/TodoCard";
import { WorkSec } from "./chat/WorkLine";
import ChatLoading from "./chat/ChatLoading";
import MsgRail from "./chat/MsgRail";
import FindBar from "./chat/FindBar";
import { renderItems } from "./chat/items";
import type { RailEntry } from "./chat/chat-types";
import { updateRailVisibility } from "../shell";
import MainSessionTree from "./chat/MainSessionTree";

// 按钮显隐：仅当消息流还有向下滚动余量时显示（4px 容差防亚像素抖动）
function updateScrollBottomVis(el: HTMLElement | null, btn: HTMLElement | null) {
  if (!el || !btn) return;
  btn.classList.toggle("hidden", !(el.scrollHeight - el.scrollTop - el.clientHeight > 4));
}

export default function Chat() {
  // 当前会话订阅：所有 session 写入走 updateSession 换引用（items/draft/streaming 变化即重渲染）
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const activePath = useAppStore((st) => st.activePath);
  const mainViewMode = useAppStore((st) => st.mainViewMode);
  const streamRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevPath = useRef<string | null>(null);
  const prevItemsLen = useRef(0);
  const atBottom = useRef(true); // 渲染前的贴底状态（scroll 监听持续记录）
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    updateScrollBottomVis(el, btnRef.current);

    // 滚动期间点亮右侧滚动条，停止后平滑淡出
    el.classList.add("scrolling");
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      el.classList.remove("scrolling");
    }, 800);
  };

  // 切会话强制落底 + 发送新消息时置顶 + 流式期间贴近底部则跟随（useLayoutEffect 在 paint 前完成，不闪旧位置）
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || !s) return;
    const switched = prevPath.current !== activePath;
    prevPath.current = activePath;
    const currentLen = s.items.length;
    const isNewUserMsg = currentLen > prevItemsLen.current && s.items[currentLen - 1]?.role === "user";
    prevItemsLen.current = currentLen;

    // 切换会话时 stream 节点被复用，旧会话的 scrollTop 对新会话无意义；
    // 发出新消息时强制滚到底部（最后一轮 min-height:100% 使得新消息刚好置顶）；
    // 流式期间若贴底则持续跟随
    if (switched || isNewUserMsg || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true; // scroll 事件异步 fire，先同步落定防同帧二次渲染回弹
    }
    updateScrollBottomVis(el, btnRef.current);
  }, [s?.items, s?.assistantDraft]);

  // 轨道显隐初始化：.dock 与会话区同帧挂载，#main 尺寸不因内部挂载改变，
  // ResizeObserver 不触发；initShell 观察发起时 dock 可能尚未存在（会话异步恢复），
  // 故此处挂载即主动算一次（启动恢复 / 新建会话切回都经此 remount）
  useLayoutEffect(() => {
    updateRailVisibility();
  }, []);

  const snapLockUntil = useRef(0);

  // 阻断标签弹窗/内嵌展开卡向外层消息流的滚动渗透（到达边界时不向外层链式传播）
  // 并提供轮次吸顶磁吸停靠：消息距离顶部过低时，下一次滚动精准卡在 offsetTop，Agent 流程完整展示
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const card = target.closest<HTMLElement>(
        ".ed-brief, .cmd-card, .bash-out, .think-body, .chg-body, .approval-card, #todoList",
      );
      if (card) {
        // 寻找当前触发点所在的最内层可纵向滚动的容器
        let scroller: HTMLElement | null = target;
        while (scroller && scroller !== card) {
          const style = window.getComputedStyle(scroller);
          const oy = style.overflowY;
          if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) {
            break;
          }
          scroller = scroller.parentElement;
        }
        if (!scroller || scroller === card) {
          const style = window.getComputedStyle(card);
          const oy = style.overflowY;
          if ((oy === "auto" || oy === "scroll") && card.scrollHeight > card.clientHeight) {
            scroller = card;
          } else {
            scroller = null;
          }
        }

        // 卡片当前区域不可纵向滚动：完全阻止滚轮事件渗透带动外层消息流
        if (!scroller) {
          e.preventDefault();
          return;
        }

        // 检查滚动边界：到顶继续向上滚，或到底继续向下滚时，阻止默认行为（禁止向上渗透）
        const { scrollTop, scrollHeight, clientHeight } = scroller;
        const delta = e.deltaY;
        if (delta > 0 && scrollTop + clientHeight >= scrollHeight - 1) {
          e.preventDefault();
          return;
        } else if (delta < 0 && scrollTop <= 0) {
          e.preventDefault();
          return;
        }
      }

      // 轮次吸顶磁吸停靠：如果下一条消息与消息区域上边距过低（即将吸顶），
      // 下一次向下滚动只滚动至刚好让该消息吸附在顶端，保证下方 Agent 处理流程完整展示
      if (e.deltaY > 0) {
        const now = Date.now();
        if (now < snapLockUntil.current) {
          e.preventDefault();
          return;
        }
        const sections = stream.querySelectorAll<HTMLElement>(".turn-section");
        const streamTop = stream.getBoundingClientRect().top;
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const dist = sec.getBoundingClientRect().top - streamTop;
          if (dist > 1 && dist <= 140) {
            e.preventDefault();
            stream.scrollTop += dist;
            snapLockUntil.current = now + 200;
            return;
          }
        }
      }
    };

    stream.addEventListener("wheel", onWheel, { passive: false });
    return () => stream.removeEventListener("wheel", onWheel);
  }, []);

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

  if (mainViewMode === "tree") {
    return <MainSessionTree />;
  }

  // 消息轨道数据：渲染期随 items 遍历收集（key 与 data-fk 锚点同源）
  const railEntries: RailEntry[] = [];
  const streamTail =
    s.streaming || s.assistantDraft ? (
      <>
        {(s.streaming || s.assistantDraft) && <WorkSec />}
        {/* 流式尾巴纯文本渲染（BUG-007 三连雷）：定稿才交给 AssistantMsg */}
        {s.assistantDraft && !isJunkPlaceholder(s.assistantDraft) && (
          <div className="msg assistant md-body streaming-draft stream-plain">{s.assistantDraft}</div>
        )}
        {s.streaming && <ChatLoading />}
      </>
    ) : null;
  const nodes = renderItems(s.items, "", railEntries, streamTail);
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
        {nodes.length === 0 && streamTail}
        {scrollBottomBtn}
      </div>
      <MsgRail entries={railEntries} sessionId={s.sessionId} streamRef={streamRef} />
      <FindBar streamRef={streamRef} />
    </>
  );
}
