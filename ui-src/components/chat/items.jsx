// 消息条目列表 → JSX：连续编辑事件（edit/write/apply_patch）合并为一个「更改」组，
// steer 待消费气泡收集到末尾统一渲染（消费前位置一直低于处理进程区），其余逐条分发。
// 迁移自 ui/chat.js renderItemList/appendChatItem；railEntries 随遍历收集（消息轨道数据：
// 每条消息一道刻度——key 与 data-fk 锚点同源，MsgRail 按 key 查 DOM 定位）。
import { isJunkPlaceholder } from "../../store.js";
import { isEditEvent, isReadEvent, isCmdEvent, isDeviceEvent, deviceNameOf } from "./util.js";
import { railToolText } from "../../shell.js";
import UserMsg from "./UserMsg.jsx";
import AssistantMsg from "./AssistantMsg.jsx";
import TurnActs from "./TurnActs.jsx";
import ThinkingRow from "./ThinkingRow.jsx";
import ToolRow from "./ToolRow.jsx";
import BashRow from "./BashRow.jsx";
import MentionRow from "./MentionRow.jsx";
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
  // 本地 bash 执行行（! 前缀）与 @ 提及回读行：不进合并组，逐条渲染
  if (item.role === "bash") {
    railEntries.push({ key, role: "bash", text: item.text });
    return <BashRow item={item} fk={key} key={key} />;
  }
  if (item.role === "mention") {
    railEntries.push({ key, role: "mention", text: (item.files || []).join("、") });
    return <MentionRow item={item} fk={key} key={key} />;
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

// 本轮 output 的末尾 assistant：其后到下一条 user 之间没有别的有效 assistant。
// loop 组内的中间输出不在顶层、不参与判断；junk 占位符不算输出（既不挡判断也不挂操作组）
function isTurnTailAssistant(items, i) {
  for (let j = i + 1; j < items.length; j++) {
    if (items[j].role === "user") return true;
    if (items[j].role === "assistant" && !isJunkPlaceholder(items[j].text)) return false;
  }
  return true;
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
    if (isReadEvent(item)) {
      // 连续读取合并「查阅」组（与更改组同款折叠机制，name 标 read 供 toolKind 分发）
      const subs = [item];
      while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem = { role: "tool", name: "read", text: "查阅", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        out.push(<ToolRow item={groupItem} key={key} />);
        continue;
      }
    }
    if (isDeviceEvent(item)) {
      // 连续同一设备的调用合并「设备」组（不同设备不混进同一组，机制同终端组）
      const dev = deviceNameOf(item.args?.path);
      const subs = [item];
      while (i + 1 < items.length && isDeviceEvent(items[i + 1]) && deviceNameOf(items[i + 1].args?.path) === dev) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem = { role: "tool", name: "device", text: "设备", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        out.push(<ToolRow item={groupItem} key={key} />);
        continue;
      }
    }
    if (isCmdEvent(item)) {
      // 连续终端命令合并「终端」组（机制同上，name 标 cmd 供 toolKind 分发）
      const subs = [item];
      while (i + 1 < items.length && isCmdEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem = { role: "tool", name: "cmd", text: "终端", group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        out.push(<ToolRow item={groupItem} key={key} />);
        continue;
      }
    }
    const node = appendItem(item, key, railEntries);
    if (node) out.push(node);
    // 一轮 output 结尾左下角挂操作组（复制/分叉）；junk assistant 的 node 为 null，不挂
    if (node && item.role === "assistant" && isTurnTailAssistant(items, i)) {
      out.push(<TurnActs item={item} key={key + "-acts"} />);
    }
  }
  for (const st of pendingSteers) out.push(appendItem(st.item, st.key, railEntries));
  return out;
}
