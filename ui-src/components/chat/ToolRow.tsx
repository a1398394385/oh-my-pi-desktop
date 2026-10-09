// Tool rows: tool name → label kind mapping and per-label row rendering. Migrated from
// ui/tool-labels.js (renderToolItem/toolKind + the render functions). Adding or removing a
// tool label only touches this file.
import type { ToolItem } from "../../types/session";
import { bumpGroupExpand, useGroupExpandVersion, cmdExpand, devExpand } from "../../store/groupExpand";
export { cmdExpand, devExpand };
import Icon from "../../Icon";
import { Ellip, FileChip, LinkedText, FadeBox, useLift, openReadFileInSidebar, uniqueFiles, splitPath, ReadRow, Spin, patchActiveItem, patchGroupSub } from "./parts";
import EditRow, { renderChange, renderReadGroup } from "./EditRow";
import { isDevicePath, deviceNameOf, yieldSummary } from "./util";
import ThinkingRow from "./ThinkingRow";
import { modelShort } from "../shared/agent/subShared";
import { t } from "../../i18n";

// ---------- Terminal row (bash/shell/eval) and background tool row (hub): expand card with command on top, output below ----------
function CmdCard({ command, item, lift }: { command?: string; item: ToolItem; lift?: boolean }) {
  return (
    <div className={"cmd-card" + (lift ? " lift" : " drop")}>
      <FadeBox className="cmd-card-cmd">{command || t("chat.noCommand")}</FadeBox>
      <FadeBox className="cmd-card-out" as="pre">
        {item.output || (item.running ? <Spin /> : t("chat.noOutput"))}
      </FadeBox>
    </div>
  );
}
function CmdRow({ item, command, iconLabel }: { item: ToolItem; command?: string; iconLabel?: string }) {
  const [closing, close] = useLift();
  const toggle = () => {
    if (item.cmdExpanded) close(() => patchActiveItem(item, (it) => { it.cmdExpanded = false; }));
    else patchActiveItem(item, (it) => { it.cmdExpanded = true; });
  };
  return (
    <>
      <div className="cmd" style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="c-ic"><Icon name="termBox" size={15} />{iconLabel}</span>
        <Ellip className="c-tx" title={command}>{command || ""}</Ellip>
        {item.running && <Spin />}
        <span className={"ed-arrow" + (item.cmdExpanded ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.cmdExpanded && <CmdCard command={command} item={item} lift={closing} />}
    </>
  );
}
function renderCmd(item: ToolItem) {
  return (
    <CmdRow
      item={item}
      command={item.args?.command || item.text || ""}
      iconLabel={item.name === "eval" ? t("chat.evalLabel") : t("chat.labelTerminal")}
    />
  );
}

// ---------- Terminal group (consecutive bash/shell/eval merged, structure copied 1:1 from the change/lookup groups) ----------
// Expand state: a dedicated WeakMap (defined in groupExpand.ts)

// In-group row UI: the full terminal label (label text + command + expand arrow), minus the
// leading icon — same as ChangeRowUI
function CmdRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const command = sub.args?.command || sub.text || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">{sub.name === "eval" ? t("chat.evalLabel") : t("chat.labelTerminal")}</span>
      <Ellip className="c-tx" title={command}>{command}</Ellip>
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// One terminal event inside a group = row + its output card expand body (expand state recorded on sub.cmdExpanded), same as ChangeEntry
function CmdEntry({ sub }: { sub: ToolItem }) {
  const command = sub.args?.command || sub.text || "";
  const [closing, close] = useLift();
  const open = !!sub.cmdExpanded && !closing;
  const toggle = () => {
    if (sub.cmdExpanded) close(() => patchGroupSub(sub, (it) => { it.cmdExpanded = false; }));
    else patchGroupSub(sub, (it) => { it.cmdExpanded = true; });
  };
  return (
    <>
      <CmdRowUI sub={sub} open={open} onToggle={toggle} />
      {sub.cmdExpanded && <CmdCard command={command} item={sub} lift={closing} />}
    </>
  );
}

// "Terminal · N commands" title row: merged group of consecutive terminal events, click to
// expand each command downward
// (structure mirrors ReadGroup: act.read single row + icon 13 + lbl + chevron)
function CmdGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // group expand state lives on a module-level WeakMap; the groupExpand channel bumps to trigger re-render
  const [closing, close] = useLift();
  const open = cmdExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (cmdExpand.has(subs[0])) close(() => { cmdExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      cmdExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="termBox" size={15} />
        <span className="lbl">{t("chat.terminalCommands", { count: subs.length })}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {cmdExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <CmdEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

export function renderCmdGroup(item: ToolItem) {
  // Merged-group members are guaranteed tool entries at runtime (grouping built in items.tsx:
  // edit/read/device/cmd events); narrowed at the discriminated-union level
  const subs = (item.group ?? []) as ToolItem[];
  return <CmdGroup subs={subs} />;
}
// hub summary: op + target + params/command/text (same interaction as the terminal row, label "Background", icon 13)
function hubSummary(args: NonNullable<ToolItem["args"]>) {
  const op = args.op || "hub";
  const target = args.name || args.application || "";
  let summary = `hub ${op}${target ? " " + target : ""}`;
  if (args.application && Array.isArray(args.args)) summary += `: ${args.application} ${args.args.join(" ")}`;
  else if (args.command) summary += `: ${args.command}`;
  else if (args.text) summary += `: ${args.text}`;
  return summary;
}
function renderHubTool(item: ToolItem) {
  return <CmdRow item={item} command={hubSummary(item.args || {})} iconLabel={t("chat.labelBackground")} />;
}

// ---------- Todo row ----------
function renderTodo(item: ToolItem) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  return (
    <div className="act todo">
      <Icon name="todo" size={15} />
      <span className="lbl">{t("chat.labelTodo")}</span>
      <Ellip className="td-tx" title={content}>{content}</Ellip>
      {td && (td.total ?? 0) > 0 && <span className="td-n">{`${td.done}/${td.total}`}</span>}
      {item.running && <Spin />}
    </div>
  );
}
// ---------- The read row has migrated to ReadRow in parts.tsx (shared by standalone / in-lookup-group, supports click-to-expand content) ----------
// ---------- grep / glob row: pattern + directory (truncated with ellipsis) ----------
function renderGrep(item: ToolItem) {
  const pat = item.args?.pattern || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  return (
    <div className="act read">
      <Icon name="read" size={15} />
      <span className="lbl">{t("chat.labelSearch")}</span>
      <Ellip className="path" title={pat}>{pat}</Ellip>
      {dir && <Ellip className="path">{dir}</Ellip>}
      {item.running && <Spin />}
    </div>
  );
}
function renderGlob(item: ToolItem) {
  const pat = item.args?.pattern || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  return (
    <div className="act read">
      <Icon name="match" size={15} />
      <span className="lbl">{t("chat.labelGlob")}</span>
      <Ellip className="path" title={pat}>{pat}</Ellip>
      {dir && <Ellip className="path">{dir}</Ellip>}
      {item.running && <Spin />}
    </div>
  );
}

// Wait row: coordination wait (background jobs / peer messages), mirrors the TUI's waitToolRenderer
// summary. The full job snapshot is available via the expandable card (details JSON / output text).
function renderWait(item: ToolItem) {
  const details = item.details as { jobs?: { status?: string }[]; agents?: unknown[]; waited?: { body?: unknown } | null } | undefined;
  let summary = "";
  const jobs = details?.jobs;
  if (jobs?.length) {
    const settled = jobs.filter((j) => j.status && j.status !== "running").length;
    summary =
      settled === 0
        ? t("chat.waitSummaryRunning", { count: jobs.length })
        : t("chat.waitSummarySettled", { settled, count: jobs.length });
  } else if (details?.agents?.length) {
    summary = t("chat.waitSummaryAgents", { count: details.agents.length });
  } else if (details?.waited?.body != null) {
    summary = typeof details.waited.body === "string" ? details.waited.body : JSON.stringify(details.waited.body);
  }
  return <ExpandableRow item={item} iconName="pause" label={t("chat.labelWait")} summary={summary || item.text || ""} />;
}

// Task row: subagent spawn (flat or batch), mirrors the TUI task card. Header meta is the
// spawn count ("Subagent 3"); the expanded card shows the assignment text plus one
// `• name ⟦agent⟧ → model:thinking` bullet per spawned subagent.
function taskSpawnCount(item: ToolItem): number {
  const args = item.args || {};
  const details = item.details as { results?: unknown[]; progress?: unknown[] } | undefined;
  return (
    details?.results?.length ??
    details?.progress?.length ??
    (Array.isArray(args.tasks) ? args.tasks.length : 0)
  );
}
function taskSummary(item: ToolItem): string {
  const count = taskSpawnCount(item);
  if (count > 0) return t("chat.taskSummaryBatch", { count });
  const args = item.args || {};
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  if (agent && agent !== "task") return `⟦${agent}⟧`;
  return typeof args.task === "string" ? args.task.split("\n")[0].trim() : "";
}
function renderTask(item: ToolItem) {
  return <ExpandableRow item={item} iconName="agents" label={t("chat.labelTask")} summary={taskSummary(item) || item.text || ""} />;
}
// Yield row: a subagent submitting its structured result (the base's YieldTool). The summary
// is the submission itself — failure reason, incremental section labels, workpool key, or a
// payload preview — read through the shared yieldSummary so the Hub activity row agrees.
function renderYield(item: ToolItem) {
  return <ExpandableRow item={item} iconName="upload" label={t("chat.labelYield")} summary={yieldSummary(item.args) || item.text || ""} />;
}
// One spawned subagent row for the expanded card's result body. Source: resolved results first,
// then live progress — never the call args (the args box shows the assignment text only).
// Agent type is ⟦bracketed⟧ unless it is the default. The base appends the resolved thinking
// level as a `:<level>` suffix on resolvedModel (only when one was resolved), so the short
// display name already reads "model:thinking".
interface TaskSpawnRecord {
  id?: unknown;
  agent?: unknown;
  resolvedModel?: unknown;
}
function taskSpawnRows(item: ToolItem): { name: string; agent: string; model: string }[] {
  const details = item.details as { results?: TaskSpawnRecord[]; progress?: TaskSpawnRecord[] } | undefined;
  const source = details?.results?.length ? details.results : details?.progress;
  if (!source?.length) return [];
  return source.map((r) => ({
    name: typeof r.id === "string" ? r.id : "",
    agent: typeof r.agent === "string" ? r.agent : "",
    model: modelShort(typeof r.resolvedModel === "string" ? r.resolvedModel : ""),
  }));
}
// Expanded task card, TUI layout: the assignment text (Goal/Constraints/Contract) on top; the
// spawn list (• name ⟦agent⟧ → model:thinking) as the result body once any details exist. The
// model-facing spawn-feedback text (item.output) is deliberately hidden when structured details
// exist — it is coordination instruction for the model, not user content.
function TaskBody({ item }: { item: ToolItem }) {
  const args = item.args || {};
  const assignment = typeof args.task === "string" && args.task.trim() ? args.task : typeof args.context === "string" ? args.context : "";
  const rows = taskSpawnRows(item);
  return (
    <>
      {assignment ? (
        <FadeBox className="cmd-card-cmd task-md" as="pre">
          <LinkedText text={truncateText(assignment)} />
        </FadeBox>
      ) : (
        <FadeBox className="cmd-card-cmd">{truncateText(args ? JSON.stringify(args, null, 2) : t("chat.noParams"))}</FadeBox>
      )}
      {rows.length > 0 ? (
        <div className="cmd-card-out">
          {rows.map((r, i) => (
            <div className="task-sub" key={i}>
              <span>{`• ${r.name}${r.agent && r.agent !== "task" ? ` ⟦${r.agent}⟧` : ""}`}</span>
              {r.model ? (
                <>
                  <Icon name="arrowRight" size={12} className="task-sub-arrow" />
                  <span className="task-sub-model">{r.model}</span>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <FadeBox className="cmd-card-out" as="pre">
          {item.output ? <LinkedText text={item.output} /> : item.running ? <Spin /> : t("chat.noOutput")}
        </FadeBox>
      )}
    </>
  );
}

// ---------- MCP row ----------
function renderMcp(item: ToolItem) {
  const tool = String(item.name || "").split("__").slice(2).join("__");
  return (
    <div className="act mcp">
      <Icon name="plug" size={15} />
      <span className="lbl">MCP</span>
      {tool && <Ellip className="path" title={item.name}>{` ${tool}`}</Ellip>}
      {item.running && <Spin />}
    </div>
  );
}

// ---------- Expandable label row: icon + label + summary, click to expand the args+result card downward ----------
function truncateText(s: string, max = 4000): string {
  s = String(s);
  return s.length > max ? s.slice(0, max) + t("chat.truncated", { count: s.length }) : s;
}
// Structured view of ask questions (question + options, ★ marks the recommended one); other tools show args JSON
function AskArgs({ questions }: { questions: NonNullable<NonNullable<ToolItem["args"]>["questions"]> }) {
  return (
    <div className="cmd-card-cmd ask-args">
      {questions.map((q, i) =>
        !q || typeof q !== "object" ? null : (
          <div className="ask-q" key={i}>
            <div className="text-text">
              {`${i + 1}. ${q.question || ""}${q.multi ? t("chat.multiSelect") : ""}`}
              {q.header && <span className="text-dim ml-[6px] text-[0.92em]" /* style-token-ignore */>{q.header}</span>}
            </div>
            {(Array.isArray(q.options) ? q.options : []).map((opt, j) => (
              <div className={"ask-opt" + (q.recommended === j ? " rec" : "")} key={j}>
                {`${q.recommended === j ? "★ " : "• "}${opt?.label || ""}${opt?.description ? ` — ${opt.description}` : ""}`}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
function ContentCard({ item, lift }: { item: ToolItem; lift?: boolean }) {
  const detailText = item.details?.displayContent?.text;
  // Result text: response output / read raw text / details JSON as fallback; when none of the
  // three exist, branch on running — result not yet arrived shows the Spin placeholder, and
  // only "never present" yields "(no output)"
  const outText =
    item.output ||
    detailText ||
    (item.details ? truncateText(JSON.stringify(item.details, null, 2)) : "");
  return (
    <div className={"cmd-card" + (lift ? " lift" : " drop")}>
      {item.name === "task" ? (
        <TaskBody item={item} />
      ) : item.name === "ask" && Array.isArray(item.args?.questions) ? (
        <AskArgs questions={item.args.questions} />
      ) : item.name === "wait" ? (
        // wait's schema has no parameters — the harness strips the injected `i` intent field
        // before execution, so the model-written intent is the only thing to show as params
        <FadeBox className="cmd-card-cmd">{item.intent || t("chat.noParams")}</FadeBox>
      ) : (
        <FadeBox className="cmd-card-cmd">
          {truncateText(item.args ? JSON.stringify(item.args, null, 2) : t("chat.noParams"))}
        </FadeBox>
      )}
      {item.name !== "task" && (
        <FadeBox className="cmd-card-out" as="pre">
          {outText ? <LinkedText text={outText} /> : item.running ? <Spin /> : t("chat.noOutput")}
        </FadeBox>
      )}
    </div>
  );
}
function ExpandableRow({ item, iconName, label, summary, summaryTitle }: { item: ToolItem; iconName: string; label: string; summary: string; summaryTitle?: string }) {
  const [closing, close] = useLift();
  const toggle = () => {
    if (item.cmdExpanded) close(() => patchActiveItem(item, (it) => { it.cmdExpanded = false; }));
    else patchActiveItem(item, (it) => { it.cmdExpanded = true; });
  };
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name={iconName} size={15} />
        <span className="lbl">{label}</span>
        <Ellip className="path" title={summaryTitle || summary}>{summary}</Ellip>
        {item.running && <Spin />}
        <span className={"ed-arrow" + (item.cmdExpanded ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.cmdExpanded && <ContentCard item={item} lift={closing} />}
    </>
  );
}
// Semantic find (jfind) row: query + optional path scope, expandable with ranked hits
function renderFind(item: ToolItem) {
  const query = item.args?.query || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  const summary = dir ? `${query} · ${dir}` : query;
  return <ExpandableRow item={item} iconName="search" label={t("chat.labelFind")} summary={summary} summaryTitle={query} />;
}
// Web search row
function renderWebSearch(item: ToolItem) {
  return <ExpandableRow item={item} iconName="globe" label={t("chat.labelWebSearch")} summary={item.args?.query || item.text || ""} />;
}
// Ask row: the first question (+N when more), title is the full question list
function renderAsk(item: ToolItem) {
  const qs = Array.isArray(item.args?.questions) ? item.args.questions : [];
  const first = qs[0]?.question || item.text || "";
  const summary = qs.length > 1 ? `${first} +${qs.length - 1}` : first;
  const title = qs.map((q) => q?.question || "").filter(Boolean).join("\n");
  return <ExpandableRow item={item} iconName="comment" label={t("chat.labelAsk")} summary={summary} summaryTitle={title || summary} />;
}
// Session-history row (read_session_context): search mode shows the query, expand mode the session id + turn range
function renderSessionContext(item: ToolItem) {
  const args = item.args || {};
  const summary = args.query
    ? String(args.query)
    : `${String(args.sessionId || "")}${args.fromTurn !== undefined || args.toTurn !== undefined ? ` · ${args.fromTurn ?? 0}–${args.toTurn ?? "end"}` : ""}`;
  return <ExpandableRow item={item} iconName="search" label={t("chat.labelSessionContext")} summary={summary || item.text || ""} />;
}
// Debug row: action and target (launch program / file:line)
function renderDebug(item: ToolItem) {
  const args = item.args || {};
  const action = args.action ? String(args.action).replaceAll("_", " ") : "request";
  const target = args.program || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return <ExpandableRow item={item} iconName="monitor" label={t("chat.labelDebug")} summary={target ? `${action} ${target}` : action} />;
}
// GitHub row: operation and object (repo/path/query/title)
function renderGithub(item: ToolItem) {
  const args = item.args || {};
  const op = args.op || "";
  const target = args.repo || args.path || args.query || args.title || args.pr || "";
  return (
    <ExpandableRow
      item={item}
      iconName="branch"
      label="GitHub"
      summary={target ? `${op} ${target}` : op || item.text || "github"}
    />
  );
}
// LSP row: action and symbol/file
function renderLsp(item: ToolItem) {
  const args = item.args || {};
  const action = args.action || "";
  const target = args.symbol || args.new_name || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return (
    <ExpandableRow
      item={item}
      iconName="search"
      label="LSP"
      summary={target ? `${action} ${target}` : action || item.text || "lsp"}
    />
  );
}
// The memory quintet (retain/recall/reflect/learn/memory_edit) shares one row
function renderMemory(item: ToolItem) {
  const args = item.args || {};
  const memories = Array.isArray(args.memories) ? args.memories : [];
  const first = memories[0]?.content || "";
  const summary =
    args.query || // recall/reflect: retrieval question
    args.memory || // learn: lesson learned
    first || // retain: first memory entry
    (args.id ? `${args.op || "update"} ${args.id}` : "") || // memory_edit: operation + memory id
    item.text ||
    "memory";
  const title = memories.length > 1 ? memories.map((m) => m?.content || "").filter(Boolean).join("\n") : "";
  return (
    <ExpandableRow
      item={item}
      iconName="memory"
      label={t("chat.labelMemory")}
      summary={memories.length > 1 ? `${summary} +${memories.length - 1}` : summary}
      summaryTitle={title}
    />
  );
}

// ---------- Tool device row (write routed to devices like xd://tui) ----------
// Device calls have no file diff; expansion shows call params and the device response
// (reuses the generic content card)
// op/name inside a device command (content is the device call's JSON params)
function deviceCmd(item: ToolItem): Record<string, unknown> | null {
  const content = item.args?.content;
  if (typeof content !== "string" || !content.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // malformed JSON: no summary patched; the raw params are still visible in the expand card
  }
}
// In-group row summary: op + name of the device command (e.g. text verifystatus)
function deviceOpText(item: ToolItem) {
  const cmd = deviceCmd(item);
  return [cmd?.op, cmd?.name].filter((v) => typeof v === "string" && v).join(" ");
}
function deviceSummary(item: ToolItem) {
  return [deviceNameOf(item.args?.path), deviceOpText(item)].filter(Boolean).join(" · ");
}
function renderDevice(item: ToolItem) {
  return <ExpandableRow item={item} iconName="plugins" label={t("chat.labelDevice")} summary={deviceSummary(item) || item.text || ""} />;
}

// ---------- Device group (consecutive same-device calls merged, structure copied 1:1 from the terminal group) ----------
// Expand state: a dedicated WeakMap (defined in groupExpand.ts)

// In-group row UI: op summary + expand arrow (the icon sits on the group title, same as in-group terminal rows)
function DeviceRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const detail = deviceOpText(sub) || sub.args?.path || sub.text || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">{t("chat.labelDevice")}</span>
      <Ellip className="c-tx" title={detail}>{detail}</Ellip>
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// One device call inside a group = row + its content card expand body (expand state recorded on sub.cmdExpanded), same as the terminal group
function DeviceEntry({ sub }: { sub: ToolItem }) {
  const [closing, close] = useLift();
  const open = !!sub.cmdExpanded && !closing;
  const toggle = () => {
    if (sub.cmdExpanded) close(() => patchGroupSub(sub, (it) => { it.cmdExpanded = false; }));
    else patchGroupSub(sub, (it) => { it.cmdExpanded = true; });
  };
  return (
    <>
      <DeviceRowUI sub={sub} open={open} onToggle={toggle} />
      {sub.cmdExpanded && <ContentCard item={sub} lift={closing} />}
    </>
  );
}

// "Device · tui · N calls" title row: merged group of consecutive same-device calls, click to expand each call downward
function DeviceGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // group expand state lives on a module-level WeakMap; the groupExpand channel bumps to trigger re-render
  const [closing, close] = useLift();
  const open = devExpand.has(subs[0]) && !closing;
  const toggle = () => {
    if (devExpand.has(subs[0])) close(() => { devExpand.delete(subs[0]); bumpGroupExpand(); });
    else {
      devExpand.set(subs[0], true);
      bumpGroupExpand();
    }
  };
  const dev = deviceNameOf(subs[0].args?.path);
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name="plugins" size={15} />
        <span className="lbl">{t("chat.deviceCalls", { count: subs.length, dev })}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {devExpand.has(subs[0]) && (
        <div className={"chg-body" + (closing ? " lift" : " drop")}>
          {subs.map((sub, i) => <DeviceEntry sub={sub} key={i} />)}
        </div>
      )}
    </>
  );
}

export function renderDeviceGroup(item: ToolItem) {
  const subs = (item.group ?? []) as ToolItem[]; // same as renderCmdGroup: group members are guaranteed tool entries
  return <DeviceGroup subs={subs} />;
}

function renderGenericTool(item: ToolItem) {
  return <div className="act">{item.name || item.text || ""}</div>;
}

// Tool name → label kind mapping (edit/change row rendering lives in EditRow.tsx; this file only dispatches)
function toolKind(item: ToolItem) {
  if (item.group) {
    // Merged group of consecutive edit/read/terminal events (name assigned during grouping in items.tsx)
    if (item.name === "read") return "readgroup";
    if (item.name === "cmd") return "cmdgroup";
    if (item.name === "device") return "devicegroup";
    return "change";
  }
  const name = item.name || item.text || "";
  // ToolRow only receives tool entries (the thinking role is already routed to ThinkingRow in
  // items.tsx), so the role check is constantly false and is omitted
  if (name === "thinking") return "think";
  if (name === "bash" || name === "shell" || name === "eval") return "cmd";
  if (name === "hub") return "hub";
  if (name === "grep" || name === "ast_grep") return "grep";
  if (name === "glob") return "glob";
  if (name === "find") return "find";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "todo") return "todo";
  if (name === "wait") return "wait";
  if (name === "task") return "task";
  if (name === "yield") return "yield";
  if (name === "read") return "read";
  if (name === "web_search") return "websearch";
  if (name === "ask") return "ask";
  if (name === "read_session_context") return "sessionctx";
  if (name === "debug") return "debug";
  if (name === "github") return "github";
  if (name === "lsp") return "lsp";
  if (name === "memory_edit" || name === "retain" || name === "recall" || name === "reflect" || name === "learn") return "memory";
  // Same semantics as isDeviceEvent (the input here is already a ToolItem; a type guard
  // would narrow the else branch to never, so the check is inlined)
  if (["edit", "write", "apply_patch"].includes(name) && isDevicePath(item.args?.path)) return "device";
  if (name === "edit" || name === "write" || name === "apply_patch") {
    const n = uniqueFiles(item.files || item.args?.files || (item.args?.path ? [item.args.path] : [])).length;
    return n > 1 ? "change" : "edit";
  }
  return "generic";
}

export default function ToolRow({ item }: { item: ToolItem }) {
  switch (toolKind(item)) {
    case "think":
      // The thinking role is already routed to ThinkingRow in items.tsx; this is the fallback
      // for tool-role entries whose name is "thinking"
      return <ThinkingRow item={item} />;
    case "cmd":
      return renderCmd(item);
    case "hub":
      return renderHubTool(item);
    case "grep":
      return renderGrep(item);
    case "glob":
      return renderGlob(item);
    case "find":
      return renderFind(item);
    case "mcp":
      return renderMcp(item);
    case "todo":
      return renderTodo(item);
    case "wait":
      return renderWait(item);
    case "task":
      return renderTask(item);
    case "yield":
      return renderYield(item);
    case "readgroup":
      return renderReadGroup(item);
    case "cmdgroup":
      return renderCmdGroup(item);
    case "read":
      return <ReadRow item={item} />;
    case "websearch":
      return renderWebSearch(item);
    case "ask":
      return renderAsk(item);
    case "sessionctx":
      return renderSessionContext(item);
    case "debug":
      return renderDebug(item);
    case "github":
      return renderGithub(item);
    case "lsp":
      return renderLsp(item);
    case "memory":
      return renderMemory(item);
    case "device":
      return renderDevice(item);
    case "devicegroup":
      return renderDeviceGroup(item);
    case "change":
      return renderChange(item);
    case "edit":
      return <EditRow item={item} />;
    default:
      return renderGenericTool(item);
  }
}
