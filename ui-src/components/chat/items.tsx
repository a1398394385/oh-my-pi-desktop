// Message item list → JSX: consecutive edit events (edit/write/apply_patch) merge into one
// "Changes" group, steer bubbles pending consumption are collected and rendered together at
// the end (before consumption they always sit below the processing area); a run of >=3
// consecutive read-only events folds into one ReadonlyGroup block, everything else
// dispatches per item. Migrated from renderItemList/appendChatItem in ui/chat.js;
// railEntries are collected along the traversal (message rail data: one tick per message —
// the key shares the same source as the data-fk anchors; MsgRail locates the DOM by key).
import type { ReactElement, ReactNode } from "react";
import type { AdvisorItem, AdvisorNote, ChatItem, RailEntry, UserItem, AssistantItem } from "./chat-types";
import { isJunkPlaceholder } from "../../store";
import { useAppStore } from "../../store/index";
import { isEditEvent, isReadEvent, isCmdEvent, isDeviceEvent, deviceNameOf, isReadonlyEvent } from "./util";
import { railToolText } from "../../shell";
import UserMsg from "./UserMsg";
import AssistantMsg from "./AssistantMsg";
import TurnActs from "./TurnActs";
import ThinkingRow from "./ThinkingRow";
import ToolRow from "./ToolRow";
import BashRow from "./BashRow";
import MentionRow from "./MentionRow";
import LoopGroup, { loopSummaryText } from "./LoopGroup";
import ReadonlyGroup, { roSummaryText } from "./ReadonlyGroup";
import AdvisorCard, { AdvisorInline } from "./AdvisorCard";
import TtsrRow from "./TtsrRow";
import BranchSwitcher from "./BranchSwitcher";
import type { BranchNavInfo, BranchRenderCtx } from "./branch-nav";
import { t } from "../../i18n";

// Ambient branch-pager context for the current top-level render pass (a
// railEntries-style side channel): nested renderItems calls (loop groups,
// read-only folds) inherit it, so fork-host bubbles inside those groups mount
// their pager too. Installed only by the top-level MessagePage pass and
// cleared before it returns — a later pass without a map never wraps stale.
let branchCtx: BranchRenderCtx | null = null;

// lastFk records the render-order-latest bubble per entryId (multi-bubble
// entries host the pager on their last bubble); BranchSwitcher reads it after
// the traversal has finished.
function makeBranchPager(item: UserItem | AssistantItem, key: string): ReactElement | null {
  const ctx = branchCtx;
  const eid = item.entryId;
  if (!ctx || !eid) return null;
  const info = ctx.map.get(eid);
  if (!info) return null;
  ctx.lastFk.set(eid, key);
  return <BranchSwitcher fk={key} entryId={eid} info={info} ctx={ctx} />;
}

function withBranchPager(node: ReactElement, item: AssistantItem, key: string): ReactElement {
  const pager = makeBranchPager(item, key);
  if (!pager) return node;
  return (
    <div className="bsw" data-eid={item.entryId} key={key}>
      {node}
      <div className="bsw-actions">{pager}</div>
    </div>
  );
}

// Single message → JSX (the railEntries side effect is collected along the render path, same
// order as the former appendChatItem's push)
function appendItem(item: ChatItem, key: string, railEntries: RailEntry[]): ReactElement | null {
  if (item.role === "user") {
    railEntries.push({ key, role: "user", text: item.text });
    // pending rides along as a captured scalar: applySteerConsumed mutates it in place,
    // so memo cannot rely on the item reference alone (same pattern as the tool row below)
    return <UserMsg item={item} fk={key} key={key} pending={item.pending} branch={makeBranchPager(item, key)} />;
  }
  if (item.role === "assistant") {
    if (isJunkPlaceholder(item.text)) return null; // junk placeholder messages render nothing and stay off the rail
    railEntries.push({ key, role: "assistant", text: item.text });
    // entryId rides along for the branch pager (memo parity with UserMsg's item prop)
    return withBranchPager(<AssistantMsg text={item.text} fk={key} key={key} entryId={item.entryId} />, item, key);
  }
  if (item.role === "thinking") {
    // The thinking label always shows under any setting; hideThinkingBlock only decides the
    // default expand state (controlled by streaming events in the store)
    railEntries.push({ key, role: "thinking", text: item.thinking || item.text });
    return <ThinkingRow item={item} fk={key} key={key} />;
  }
  if (item.role === "tool") {
    railEntries.push({ key, role: "tool", text: railToolText(item) });
    // The extra scalars are mutation snapshots (T2): tool_update mutates the item in
    // place (same object reference), so memo compares these captured values instead —
    // only rows whose own data changed re-render on a delta flush
    return (
      <ToolRow
        item={item}
        key={key}
        output={item.output}
        running={!!item.running}
        files={item.files}
        added={item.added}
        removed={item.removed}
        todo={item.todo}
        details={item.details}
        diffContent={item.diffContent}
      />
    );
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
  // TTSR rule-injection notice: a read-only row with no rail tick of its own — it either sits
  // inside a read-only fold run or stands alone at the interruption point
  if (item.role === "ttsr") return <TtsrRow item={item} key={key} />;
  // Advisor rows are dispatched by renderItems (they expand into an inline row plus a
  // card); reaching here means a caller skipped that, so drop instead of drawing an error.
  if (item.role === "advisor") return null;
  railEntries.push({ key, role: "err", text: item.text });
  return <div className="act err" key={key}>{`✗ ${item.text}`}</div>;
}

/** Automation created by this item, if any: the device result's details (xd:// dispatch
 *  wraps the tool's own details under .inner). A reloaded session folds the turn's tool
 *  rows into a loop group, so the folded items count too. */
function createdAutomationOf(item: ChatItem): { id: string; title: string } | undefined {
  const ofTool = (it: ChatItem) => (it.role === "tool" ? it.details?.xdev?.inner?.automation : undefined);
  const direct = ofTool(item);
  if (direct?.id) return direct;
  if (item.role === "loop") {
    for (const sub of item.items ?? []) {
      const hit = ofTool(sub);
      if (hit?.id) return hit;
    }
  }
  return undefined;
}

// Mutation signature of a folded read-only run (T2): the run's tool rows mutate in place
// (tool_update assigns files/output/running/...), and ReadonlyGroup receives a freshly
// built subs array every traversal, so its memo compares this captured string plus the
// sub-item identities instead of the array reference.
function readonlySig(subs: ChatItem[]): string {
  let sig = "";
  for (const it of subs) {
    const t = it as ChatItem & {
      files?: string[];
      added?: number;
      removed?: number;
      output?: string;
      running?: boolean;
      todo?: unknown;
      details?: unknown;
      diffContent?: string;
      expanded?: boolean;
    };
    sig += `${t.files?.length ?? 0},${t.added ?? 0},${t.removed ?? 0},${t.output?.length ?? 0},${t.running ? 1 : 0},${t.todo ? 1 : 0},${t.details ? 1 : 0},${t.diffContent ? 1 : 0};`;
    // A ttsr row's disclosure state lands in place, so the memoized block must see it
    if (t.role === "ttsr") sig += t.expanded ? "e" : "-";
  }
  return sig;
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

// Advisor batch → nodes. A visible process keeps its blocking notes where they fired
// (the batch's position in the stream IS the injection point); everything else joins the
// turn-tail card. With the process collapsed nothing inline survives, so the caller hands
// the whole batch to the card instead (inline = false).
function advisorNodes(item: AdvisorItem, key: string, inline: boolean): ReactElement[] {
  const out: ReactElement[] = [];
  const blockers = inline ? item.notes.filter((n) => (n.severity ?? "concern") === "blocker") : [];
  const cardNotes = blockers.length ? item.notes.filter((n) => (n.severity ?? "concern") !== "blocker") : item.notes;
  if (blockers.length) out.push(<AdvisorInline notes={blockers} key={key + "-in"} />);
  if (cardNotes.length) out.push(<AdvisorCard notes={cardNotes} key={key + "-card"} />);
  return out;
}

// Agent process display style (ui.prefs.agentProcessStyle):
//   standard — a run of >=3 read-only tool events folds into one block
//   detailed — no read-only run fold (rows lay out flat), same-type groups stay
//   expanded — no read-only run fold and no same-type merging at all
//   concise  — folds like standard; the live turn hides its process rows entirely
//              (MessagePage's hideProcessFrom), so this only shapes the reveal
function processStyle(): "standard" | "detailed" | "expanded" {
  const v = useAppStore.getState().uiPrefs.agentProcessStyle;
  return v === "detailed" || v === "expanded" ? v : "standard";
}

// Scans a read-only run starting at items[i] (items[i] must satisfy isReadonlyEvent).
// Thinking, request-error and TTSR-injection rows inside the run are collected into the block
// but not counted; any other role or a non-read-only tool event ends the run. Returns null when
// the run holds fewer than `min` read-only events (the caller then falls through to the
// per-type group blocks). Error rows must not break the scan: a mid-run request failure
// (e.g. socket closed) would otherwise split one flow into <3 fragments that never fold.
// min is 3 (the >=3 merge) under the "standard" style and Infinity under the other
// two, where read-only rows never merge and always lay out flat.
function scanReadonlyRun(items: ChatItem[], i: number): { run: ChatItem[]; next: number } | null {
  const min = processStyle() === "standard" ? 3 : Infinity;
  const run: ChatItem[] = [];
  let roCount = 0;
  let j = i;
  while (j < items.length) {
    const it = items[j];
    if (isReadonlyEvent(it)) {
      run.push(it);
      roCount++;
      j++;
    } else if (it.role === "thinking" || it.role === "error" || it.role === "ttsr") {
      run.push(it);
      j++;
    } else break;
  }
  return roCount >= min ? { run, next: j } : null;
}

// noReadonlyFold: the level-2 fold is skipped (used by ReadonlyGroup's expansion body,
// whose items are already the folded run — re-scanning them would nest a block inside
// itself and recurse infinitely)
// hideProcessFrom: index of the live turn's user row; everything after it that is not an
// assistant output is dropped (the concise style's live view). Folding is untouched, so
// the same rows lay out in standard shape once the reveal toggle disables the filter.
export function renderItems(
  items: ChatItem[],
  pfx: string,
  railEntries: RailEntry[],
  streamTail?: ReactNode,
  opts?: { noReadonlyFold?: boolean; hideProcessFrom?: number; branchNav?: Map<string, BranchNavInfo> | null },
): ReactElement[] {
  if (pfx === "" && opts?.branchNav) branchCtx = { map: opts.branchNav, lastFk: new Map() };
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
      // Advisor batch: blocking notes keep the row's position, the rest becomes a card.
      // Reaching this container at all means the batch sits inside a visible process.
      if (item.role === "advisor") {
        out.push(...advisorNodes(item, key, true));
        continue;
      }
      // Level-2 fold first: a >=3 read-only run wraps the level-3 groups below
      if (!opts?.noReadonlyFold && isReadonlyEvent(item)) {
        const g = scanReadonlyRun(items, i);
        if (g) {
          railEntries.push({ key, role: "tool", text: roSummaryText(g.run) });
          out.push(<ReadonlyGroup subs={g.run} pfx={key + "-"} sig={readonlySig(g.run)} key={key} />);
          i = g.next - 1;
          continue;
        }
      }
      // The "expanded" style skips the level-3 merge blocks entirely (they consume the
      // following same-type events, so gating only the group push would swallow rows)
      const mergeSameType = processStyle() !== "expanded";
      if (mergeSameType && isEditEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", text: t("chat.labelChange"), group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (mergeSameType && isReadEvent(item)) {
        const subs: ChatItem[] = [item];
        while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
        if (subs.length > 1) {
          const groupItem: ChatItem = { role: "tool", name: "read", text: t("chat.labelReadGroup"), group: subs };
          railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
          out.push(<ToolRow item={groupItem} key={key} />);
          continue;
        }
      }
      if (mergeSameType && isDeviceEvent(item)) {
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
      if (mergeSameType && isCmdEvent(item)) {
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
        out.push(<TurnActs item={item} entryId={item.entryId} endMs={item.endMs} key={key + "-acts"} />);
      }
    }
    for (const st of pendingSteers) {
      const node = appendItem(st.item, st.key, railEntries);
      if (node) out.push(node);
    }
    return out;
  }

  // Top-level main chat flow: grouped by turn (TurnSection) for snap-to-top
  // userNode is null for a slash-command block: the host consumes the typed command and the
  // optimistic user bubble is withdrawn (command_result consumed), so the output card has no
  // user row of its own to anchor under
  interface TurnGroup {
    key: string;
    userKey: string;
    userNode: ReactElement | null;
    flowNodes: ReactElement[];
    actsNode: ReactElement | null;
    // Notes that belong to the turn's closing card: every non-blocker batch (their rows
    // would otherwise repeat the card inline) plus every batch the concise live view hid
    // (blockers included — with no process row to sit in the card is their only home).
    advice: AdvisorNote[];
    /** Automation this turn created (automations_manage details): TurnActs then offers the
     *  jump to that task's editor. */
    createdAutomation?: { id: string; title: string };
  }

  const initialNodes: ReactElement[] = [];
  const initialAdvice: AdvisorNote[] = [];
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
    // Concise live view: this turn keeps its user row and assistant outputs only. The
    // check sits before the fold scans so a run straddling the boundary is never merged
    // into a block that then gets dropped.
    if (opts?.hideProcessFrom !== undefined && i > opts.hideProcessFrom && item.role !== "assistant" && item.role !== "user") {
      if (item.role === "advisor") {
        if (currentTurn) currentTurn.advice.push(...item.notes);
        else initialAdvice.push(...item.notes);
      }
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
        advice: [],
      };
      continue;
    }

    let node: ReactElement | null = null;

    // A task created in this turn: its id rides the tool result's details (xd:// wraps the
    // tool's own details under .inner), so the turn's action row can offer the jump. Read
    // here, before the fold/merge scans swallow this row (i jumps past merged items).
    if (currentTurn) {
      const created = createdAutomationOf(item);
      if (created) currentTurn.createdAutomation = created;
    }

    // Advisor batch in a visible process: blocking notes keep their position, everything
    // else joins the turn's closing card. Bypassing the fold scans is the point — an
    // advisory row is not a process row, so it also breaks a read-only run it sits between.
    if (item.role === "advisor") {
      const blockers = item.notes.filter((n) => (n.severity ?? "concern") === "blocker");
      const rest = blockers.length ? item.notes.filter((n) => (n.severity ?? "concern") !== "blocker") : item.notes;
      if (blockers.length) {
        const row = <AdvisorInline notes={blockers} key={key + "-in"} />;
        if (currentTurn) currentTurn.flowNodes.push(row);
        else initialNodes.push(row);
      }
      if (rest.length) {
        if (currentTurn) currentTurn.advice.push(...rest);
        else initialAdvice.push(...rest);
      }
      continue;
    }

    // A collapsed process group hides an advice row inside it; lift the notes to the
    // turn's closing card so the injection stays readable. Expanded groups render the row
    // in place through the child-container branch.
    if (item.role === "loop" && item.collapsed) {
      const folded = (item.items ?? []).flatMap((it) => (it.role === "advisor" ? it.notes : []));
      if (folded.length) {
        if (currentTurn) currentTurn.advice.push(...folded);
        else initialAdvice.push(...folded);
      }
    }

    // Level-2 fold first: a >=3 read-only run wraps the level-3 groups below
    if (!opts?.noReadonlyFold && isReadonlyEvent(item)) {
      const g = scanReadonlyRun(items, i);
      if (g) {
        railEntries.push({ key, role: "tool", text: roSummaryText(g.run) });
        node = <ReadonlyGroup subs={g.run} pfx={key + "-"} sig={readonlySig(g.run)} key={key} />;
        i = g.next - 1;
      }
    }

    const mergeSameType = processStyle() !== "expanded";
    if (mergeSameType && isEditEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isEditEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", text: t("chat.labelChange"), group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (mergeSameType && !node && isReadEvent(item)) {
      const subs: ChatItem[] = [item];
      while (i + 1 < items.length && isReadEvent(items[i + 1])) subs.push(items[++i]);
      if (subs.length > 1) {
        const groupItem: ChatItem = { role: "tool", name: "read", text: t("chat.labelReadGroup"), group: subs };
        railEntries.push({ key, role: "tool", text: railToolText(groupItem) });
        node = <ToolRow item={groupItem} key={key} />;
      }
    }
    if (mergeSameType && !node && isDeviceEvent(item)) {
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
    if (mergeSameType && !node && isCmdEvent(item)) {
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
      const actsNode = (
        <TurnActs
          item={item}
          entryId={item.entryId}
          endMs={item.endMs}
          automation={currentTurn?.createdAutomation}
          key={key + "-acts"}
        />
      );
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

  // Closing card: after everything the turn shows, one card per turn (severity counts in
  // the head, T-n kept for the expanded body).
  if (initialAdvice.length) initialNodes.push(<AdvisorCard notes={initialAdvice} key="adv-initial" />);
  for (const t of turns) {
    if (t.advice.length) t.flowNodes.push(<AdvisorCard notes={t.advice} key={t.key + "-adv"} />);
  }

  const out: ReactElement[] = [...initialNodes];

  // The filter only ever lands on the last turn: .concise-live spaces the outputs that
  // end up back to back once the process rows between them are gone
  const conciseLive = opts?.hideProcessFrom !== undefined;

  for (const t of turns) {
    out.push(
      <div className="turn-section" key={t.key}>
        <div className="turn-body">
          {t.userNode ? (
            <div className="sticky-user-wrap">
              <div className="sticky-user-inner">
                {t.userNode}
              </div>
            </div>
          ) : null}
          <div className={"turn-flow" + (conciseLive && t === turns[turns.length - 1] ? " concise-live" : "")}>
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

  branchCtx = null; // top-level pass done: later passes without a map must not wrap stale
  return out;
}
