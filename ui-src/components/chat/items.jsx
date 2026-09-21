// 消息条目列表 → JSX：连续编辑事件（edit/write/apply_patch）合并为一个「更改」组，
// steer 待消费气泡收集到末尾统一渲染（消费前位置一直低于处理进程区），其余逐条分发。
// 迁移自 ui/chat.js renderItemList/appendChatItem；railEntries 随遍历收集（消息轨道数据：
// 每条消息一道刻度——key 与 data-fk 锚点同源，MsgRail 按 key 查 DOM 定位）。
import { isJunkPlaceholder } from "../../store.js";
import { isEditEvent } from "../../../ui/tool-rows.js";
import { railToolText } from "../../shell.js";
import UserMsg from "./UserMsg.jsx";
import AssistantMsg from "./AssistantMsg.jsx";
import ThinkingRow from "./ThinkingRow.jsx";
import ToolRow from "./ToolRow.jsx";
import LoopGroup, { loopSummaryText } from "./LoopGroup.jsx";
import ApprovalCard from "./ApprovalCard.jsx";

// 单条消息 → JSX（railEntries 副作用随渲染路径收集，与原 appendChatItem 的 push 同序）
function appendItem(item, key, railEntries) {
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
  if (item.role === "meta") {
    railEntries.push({ key, role: "meta", text: item.text });
    return <div className="act" key={key}>{item.text}</div>;
  }
  if (item.role === "approval") {
    railEntries.push({ key, role: "approval", text: item.title });
    return <ApprovalCard item={item} key={key} />;
  }
  railEntries.push({ key, role: "err", text: item.text });
  return <div className="act err" key={key}>{`✗ ${item.text}`}</div>;
}

export function renderItems(items, pfx, railEntries) {
  const out = [];
  const pendingSteers = []; // steer 待消费气泡收集到末尾统一渲染（刻度也随之排末尾）
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = pfx + i;
    if (item.role === "user" && item.pending === "steer") {
      pendingSteers.push({ item, key });
      continue;
    }
    if (isEditEvent(item)) {
      const subs = [item];
      while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem = { role: "tool", text: "更改", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        out.push(<ToolRow item={groupItem} key={key} />);
        continue;
      }
    }
    const node = appendItem(item, key, railEntries);
    if (node) out.push(node);
  }
  for (const st of pendingSteers) out.push(appendItem(st.item, st.key, railEntries));
  return out;
}
