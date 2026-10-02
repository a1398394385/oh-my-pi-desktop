// Message item list → JSX: consecutive edit events (edit/write/apply_patch) merge into one
// "Changes" group, steer bubbles pending consumption are collected and rendered together at
// the end (before consumption they always sit below the processing area), everything else
// dispatches per item. Migrated from renderItemList/appendChatItem in ui/chat.js;
// railEntries are collected along the traversal (message rail data: one tick per message —
// the key shares the same source as the data-fk anchors; MsgRail locates the DOM by key).
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
import { t } from "../../i18n";

// Single message → JSX (the railEntries side effect is collected along the render path, same
// order as the former appendChatItem's push)
function appendItem(item: ChatItem, key: string, railEntries: RailEntry[]): ReactElement | null {
  if (item.role === "user") {
    railEntries.push({ key, role: "user", text: item.text });
    return <UserMsg item={item} fk={key} key={key} />;
  }
  if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return null; // junk placeholder messages render nothing and stay off the rail
    railEntries.push({ key, role: "assistant", text: item.text });
    return <AssistantMsg text={item.text} fk={key} key={key} />;
  }
  if (item.role === "thinking") {
    // The thinking label always shows under any setting; hideThinkingBlock only decides the
    // default expand state (controlled by streaming events in the store)
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
  // Local bash execution rows (! prefix) and @ mention read-back rows: not merged into
  // groups, rendered one by one
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
  // Phase separator row (background compact / handoff / rename): centered text between
  // horizontal lines, not in the left-aligned action rows
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

// The tail assistant of this turn's output:
// 1. Valid only at top level (pfx === "") and for non-junk messages; sub-items inside loop groups do not show.
// 2. If a tool, loop group, bash, or a later valid assistant appears between it and the next user, do not show.
// 3. If no user is encountered until the list end (currently the latest turn), the flow must have finished (not streaming, no draft, no running tool).
function isTurnTailAssistant(items: ChatItem[], i: number, pfx: string): boolean {
  if (pfx !== "") return false;
  let hasLaterUser = false;
  for (let j = i + 1; j < items.length; j++) {
    const next = items[j];
    if (next.role === "user") {
      hasLaterUser = true;
      break;
    }
    // If a later tool, loop group, or bash exists, the flow continues after this output; do not show
    if (next.role === "tool" || next.role === "loop" || next.role === "bash") {
      return false;
    }
    // If a later valid assistant exists, this is not the last output segment; do not show
    if (next.role === "assistant" && !isJunkPlaceholder(next.text)) {
      return false;
    }
  }
  // No next user after it means it belongs to the current latest turn: if the flow has not
  // finished (streaming/draft/running item), do not show
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
  // Child container (e.g. inside LoopGroup): keep the original flat rendering mechanism
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
          const groupItem: ChatItem = { role: "tool", text: t("chat.labelChange"), group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (isReadEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "read", text: t("chat.labelReadGroup"), group: subs };
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
          const groupItem: ChatItem = { role: "tool", name: "device", text: t("chat.labelDevice"), group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (isCmdEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isCmdEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "cmd", text: t("chat.labelTerminal"), group: subs };
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

  // Top-level main chat flow: grouped by turn (TurnSection) for snap-to-top
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
        const groupItem: ChatItem = { role: "tool", text: t("chat.labelChange"), group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (!node && isReadEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "read", text: t("chat.labelReadGroup"), group: subs };
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
        const groupItem: ChatItem = { role: "tool", name: "device", text: t("chat.labelDevice"), group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (!node && isCmdEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isCmdEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "cmd", text: t("chat.labelTerminal"), group: subs };
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

  // If the latest turn is streaming, append the streaming tail to the end of the last turn's content
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
