// 消息条目列表 → JSX：连续编辑事件（edit/write/apply_patch）合并为一个「更改」组，
// steer 待消费气泡收集到末尾统一渲染（消费前位置一直低于处理进程区），其余逐条分发。
// 迁移自 ui/chat.js renderItemList/appendChatItem；railEntries 随遍历收集（消息轨道数据：
// 每条消息一道刻度——key 与 data-fk 锚点同源，MsgRail 按 key 查 DOM 定位）。
import type { ReactElement, ReactNode } from "react";
import type { ChatItem, RailEntry } from "./chat-types";
import { isJunkPlaceholder } from "../../store";
import { useAppStore } from "../../store/index";
import { isEditEvent, isReadEvent, isCmdEvent, isDeviceEvent, deviceNameOf } from "./util";
import { railToolText } from "../../shell";
import UserMsg from "./UserMsg";
import AssistantMsg from "./AssistantMsg";
import TurnActs from "./TurnActs";
import ThinkingRow from "./ThinkingRow";
import ToolRow from "./ToolRow";
import BashRow from "./BashRow";
import MentionRow from "./MentionRow";
import LoopGroup, { loopSummaryText } from "./LoopGroup";

// 单条消息 → JSX（railEntries 副作用随渲染路径收集，与原 appendChatItem 的 push 同序）
function appendItem(item: ChatItem, key: string, railEntries: RailEntry[]): ReactElement | null {
  if (item.role === "user") {
    railEntries.push({ key, role: "user", text: item.text });
    return <UserMsg item={item} fk={key} key={key} />;
  }
  if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return null; // 占位符消息不渲染、不进轨道
    railEntries.push({ key, role: "assistant", text: item.text });
    return <AssistantMsg text={item.text} fk={key} key={key} />;
  }
  if (item.role === "thinking") {
    // 任何设置下思考标签都显示，hideThinkingBlock 只决定默认展开与否（store 流式事件控制）
    railEntries.push({ key, role: "thinking", text: item.thinking || item.text });
    return <ThinkingRow item={item} fk={key} key={key} />;
  }
  if (item.role === "tool") {
    railEntries.push({ key, role: "tool", text: railToolText(item) });
    return <ToolRow item={item} key={key} />;
  }
  if (item.role === "loop") {
    railEntries.push({ key, role: "meta", text: loopSummaryText(item) });
    return <LoopGroup item={item} fk={key} railEntries={railEntries} key={key} />;
  }
  // 本地 bash 执行行（! 前缀）与 @ 提及回读行：不进合并组，逐条渲染
  if (item.role === "bash") {
    railEntries.push({ key, role: "bash", text: item.text });
    return <BashRow item={item} key={key} />;
  }
  if (item.role === "mention") {
    railEntries.push({ key, role: "mention", text: (item.files || []).join("、") });
    return <MentionRow item={item} key={key} />;
  }
  if (item.role === "meta") {
    railEntries.push({ key, role: "meta", text: item.text });
    return <div className="act" key={key}>{item.text}</div>;
  }
  // 阶段分隔行（后台压缩/交接/重命名）：居中横线夹字，不进左对齐动作行
  if (item.role === "phase") {
    railEntries.push({ key, role: "meta", text: item.text });
    return (
      <div className="act phase" key={key}>
        <i className="ph-line" />
        <span>{item.text}</span>
        <i className="ph-line" />
      </div>
    );
  }
  railEntries.push({ key, role: "err", text: item.text });
  return <div className="act err" key={key}>{`✗ ${item.text}`}</div>;
}

// 本轮 output 的末尾 assistant：
// 1. 仅顶层（pfx === ""）且非 junk 消息有效；loop 组内子项不显示。
// 2. 其后到下一条 user 之间若还有 tool、loop 组、bash、或后续有效 assistant，不显示。
// 3. 若到列表末尾仍未遇到 user（当前处于最新一轮），流程必须已结束（非 streaming、非 draft、无 running 工具）。
function isTurnTailAssistant(items: ChatItem[], i: number, pfx: string): boolean {
  if (pfx !== "") return false;
  let hasLaterUser = false;
  for (let j = i + 1; j < items.length; j++) {
    const next = items[j];
    if (next.role === "user") {
      hasLaterUser = true;
      break;
    }
    // 若后续还有 tool、loop 组或 bash，说明该 output 之后流程还在继续，不显示
    if (next.role === "tool" || next.role === "loop" || next.role === "bash") {
      return false;
    }
    // 若后续还有有效 assistant，说明当前不是最后一段 output，不显示
    if (next.role === "assistant" && !isJunkPlaceholder(next.text)) {
      return false;
    }
  }
  // 若其后没有下一条 user，说明属于当前最新一轮：若流程未结束（streaming/draft/running 项），不显示
  if (!hasLaterUser) {
    const st = useAppStore.getState();
    const active = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (active?.streaming || active?.assistantDraft) {
      return false;
    }
    if (items.some((it) => (it as { running?: boolean }).running)) {
      return false;
    }
  }
  return true;
}

export function renderItems(
  items: ChatItem[],
  pfx: string,
  railEntries: RailEntry[],
  streamTail?: ReactNode,
): ReactElement[] {
  // 子级容器（如 LoopGroup 内部）：保持原来的平铺渲染机制
  if (pfx !== "") {
    const out: ReactElement[] = [];
    const pendingSteers: { item: ChatItem; key: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = pfx + i;
      if (item.role === "user" && item.pending === "steer") {
        pendingSteers.push({ item, key });
        continue;
      }
      if (isEditEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", text: "更改", group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (isReadEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "read", text: "查阅", group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (isDeviceEvent(item)) {
        const dev = deviceNameOf(item.args?.path);
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length) {
          const nx = items[i + 1];
          if (!isDeviceEvent(nx) || deviceNameOf(nx.args?.path) !== dev) break;
          subs.push(nx);
          i++;
        }
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "device", text: "设备", group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (isCmdEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isCmdEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "cmd", text: "终端", group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      const node = appendItem(item, key, railEntries);
      if (node) out.push(node);
      if (node && item.role === "assistant" && isTurnTailAssistant(items, i, pfx)) {
        out.push(<TurnActs item={item} key={key + "-acts"} />);
      }
    }
    for (const st of pendingSteers) {
      const node = appendItem(st.item, st.key, railEntries);
      if (node) out.push(node);
    }
    return out;
  }

  // 顶层主对话流：按轮次（TurnSection）分组吸顶
  interface TurnGroup {
    key: string;
    userKey: string;
    userNode: ReactElement;
    flowNodes: ReactElement[];
    actsNode: ReactElement | null;
  }

  const initialNodes: ReactElement[] = [];
  const turns: TurnGroup[] = [];
  let currentTurn: TurnGroup | null = null;
  const pendingSteers: { item: ChatItem; key: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = pfx + i;
    if (item.role === "user" && item.pending === "steer") {
      pendingSteers.push({ item, key });
      continue;
    }

    if (item.role === "user") {
      const userNode = appendItem(item, key, railEntries);
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        key: "turn-" + key,
        userKey: key,
        userNode: userNode!,
        flowNodes: [],
        actsNode: null,
      };
      continue;
    }

    let node: ReactElement | null = null;

    if (isEditEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", text: "更改", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (!node && isReadEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "read", text: "查阅", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (!node && isDeviceEvent(item)) {
      const dev = deviceNameOf(item.args?.path);
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length) {
        const nx = items[i + 1];
        if (!isDeviceEvent(nx) || deviceNameOf(nx.args?.path) !== dev) break;
        subs.push(nx);
        i++;
      }
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "device", text: "设备", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (!node && isCmdEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isCmdEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "cmd", text: "终端", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }

    if (!node) {
      node = appendItem(item, key, railEntries);
    }

    if (node) {
      if (currentTurn) {
        currentTurn.flowNodes.push(node);
      } else {
        initialNodes.push(node);
      }
    }

    if (node && item.role === "assistant" && isTurnTailAssistant(items, i, pfx)) {
      const actsNode = <TurnActs item={item} key={key + "-acts"} />;
      if (currentTurn) {
        currentTurn.actsNode = actsNode;
      } else {
        initialNodes.push(actsNode);
      }
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  // 最新一轮若正在流式输出，将流式尾巴追加到最后一轮内容末尾
  if (streamTail && turns.length > 0) {
    turns[turns.length - 1].flowNodes.push(
      <div key="stream-tail-wrap">{streamTail}</div>,
    );
  }

  const out: ReactElement[] = [...initialNodes];

  for (const t of turns) {
    out.push(
      <div className="turn-section" key={t.key}>
        <div className="turn-body">
          <div className="sticky-user-wrap">
            <div className="sticky-user-inner">
              {t.userNode}
            </div>
          </div>
          <div className="turn-flow">
            {t.flowNodes}
          </div>
        </div>
        {t.actsNode}
      </div>,
    );
  }

  for (const st of pendingSteers) {
    const node = appendItem(st.item, st.key, railEntries);
    if (node) out.push(node);
  }

  return out;
}
