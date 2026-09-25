// 工具行：工具名 → 标签种类映射与各标签行渲染。迁移自 ui/tool-labels.js
// （renderToolItem/toolKind + 各 render 函数）。加减工具标签只改本文件。
import type { ToolItem } from "../../types/session";
import { bumpGroupExpand, useGroupExpandVersion } from "../../store/groupExpand";
import Icon from "../../Icon";
import { Ellip, FileChip, LinkedText, FadeBox, useLift, openReadFileInSidebar, uniqueFiles, splitPath, ReadRow, Spin, patchActiveItem, patchGroupSub } from "./parts";
import EditRow, { renderChange, renderReadGroup } from "./EditRow";
import { isDevicePath, deviceNameOf } from "./util";
import ThinkingRow from "./ThinkingRow";

// ---------- 终端行（bash/shell/eval）与后台工具行（hub）：上命令、下输出的展开卡 ----------
function CmdCard({ command, item, lift }: { command?: string; item: ToolItem; lift?: boolean }) {
  return (
    <div className={"cmd-card" + (lift ? " lift" : " drop")}>
      <FadeBox className="cmd-card-cmd">{command || "（无命令）"}</FadeBox>
      <FadeBox className="cmd-card-out" as="pre">
        {item.output || (item.running ? <Spin /> : "（无输出）")}
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
      iconLabel={item.name === "eval" ? "求值" : "终端"}
    />
  );
}

// ---------- 终端组（连续 bash/shell/eval 合并，结构一比一抄更改/查阅组） ----------
// 展开状态：独立 WeakMap（以组内首个 item 为键，引用稳定跨重绘保留）
export const cmdExpand = new WeakMap<ToolItem, boolean>();

// 组内行 UI：完整终端标签（标签文字 + 命令 + 展开箭头），仅去掉行首图标——与 ChangeRowUI 同款
function CmdRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const command = sub.args?.command || sub.text || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">{sub.name === "eval" ? "求值" : "终端"}</span>
      <Ellip className="c-tx" title={command}>{command}</Ellip>
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// 组内一条终端事件 = 行 + 其输出卡展开体（展开态记在 sub.cmdExpanded 上），与 ChangeEntry 同款
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

// 「终端 · N 条命令」标题行：连续终端事件合并组，点击向下展开各条命令
//（结构对照 ReadGroup：act.read 单行 + 图标 13 + lbl + chevron）
function CmdGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // 组展开态在模块级 WeakMap 上,靠 groupExpand 通道 bump 触发重渲染
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
        <span className="lbl">{`终端 · ${subs.length} 条命令`}</span>
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
  // 合并组成员运行期必为 tool 条目(items.tsx 分组构造:edit/read/device/cmd 事件),判别联合层面收窄
  const subs = (item.group ?? []) as ToolItem[];
  return <CmdGroup subs={subs} />;
}
// hub 摘要：op + 目标 + 参数/命令/文本（与终端行同一交互，标签为「后台」、图标 13）
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
  return <CmdRow item={item} command={hubSummary(item.args || {})} iconLabel="后台" />;
}

// ---------- 待办行 ----------
function renderTodo(item: ToolItem) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  return (
    <div className="act todo">
      <Icon name="todo" size={15} />
      <span className="lbl">待办</span>
      <Ellip className="td-tx" title={content}>{content}</Ellip>
      {td && (td.total ?? 0) > 0 && <span className="td-n">{`${td.done}/${td.total}`}</span>}
      {item.running && <Spin />}
    </div>
  );
}
// ---------- 读取行已迁移 parts.tsx ReadRow（单条/查阅组内共用，支持点击展开内容） ----------
// ---------- grep / glob 行：模式串 + 目录（截断省略） ----------
function renderGrep(item: ToolItem) {
  const pat = item.args?.pattern || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  return (
    <div className="act read">
      <Icon name="read" size={15} />
      <span className="lbl">搜索</span>
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
      <Icon name="ftFile" size={15} />
      <span className="lbl">查找</span>
      <Ellip className="path" title={pat}>{pat}</Ellip>
      {dir && <Ellip className="path">{dir}</Ellip>}
      {item.running && <Spin />}
    </div>
  );
}

// ---------- MCP 行 ----------
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

// ---------- 可展开标签行：图标 + 中文标签 + 摘要，点击向下展开 参数+结果 卡片 ----------
function truncateText(s: string, max = 4000): string {
  s = String(s);
  return s.length > max ? s.slice(0, max) + ` …(截断,共${s.length}字)` : s;
}
// ask 的 questions 结构化展示（问题 + 选项，★ 推荐项），其余工具是 args JSON
function AskArgs({ questions }: { questions: NonNullable<NonNullable<ToolItem["args"]>["questions"]> }) {
  return (
    <div className="cmd-card-cmd ask-args">
      {questions.map((q, i) =>
        !q || typeof q !== "object" ? null : (
          <div className="ask-q" key={i}>
            <div className="text-text">
              {`${i + 1}. ${q.question || ""}${q.multi ? "（多选）" : ""}`}
              {q.header && <span className="text-dim ml-[6px] text-[0.92em]">{q.header}</span>}
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
  // 结果文本：回包 output / 读取原文 / details JSON 兜底；三者皆无时按 running 分流——
  // 结果还没到走 Spin 占位，本来就没有才是「（无输出）」
  const outText =
    item.output ||
    detailText ||
    (item.details ? truncateText(JSON.stringify(item.details, null, 2)) : "");
  return (
    <div className={"cmd-card" + (lift ? " lift" : " drop")}>
      {item.name === "ask" && Array.isArray(item.args?.questions) ? (
        <AskArgs questions={item.args.questions} />
      ) : (
        <FadeBox className="cmd-card-cmd">
          {truncateText(item.args ? JSON.stringify(item.args, null, 2) : "（无参数）")}
        </FadeBox>
      )}
      <FadeBox className="cmd-card-out" as="pre">
        {outText ? <LinkedText text={outText} /> : item.running ? <Spin /> : "（无输出）"}
      </FadeBox>
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
        <span className={"ed-arrow" + (item.cmdExpanded ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.cmdExpanded && <ContentCard item={item} lift={closing} />}
    </>
  );
}
// 联网搜索行
function renderWebSearch(item: ToolItem) {
  return <ExpandableRow item={item} iconName="globe" label="联网搜索" summary={item.args?.query || item.text || ""} />;
}
// 提问行：首个问题（多个时 +N），title 为完整问题列表
function renderAsk(item: ToolItem) {
  const qs = Array.isArray(item.args?.questions) ? item.args.questions : [];
  const first = qs[0]?.question || item.text || "";
  const summary = qs.length > 1 ? `${first} +${qs.length - 1}` : first;
  const title = qs.map((q) => q?.question || "").filter(Boolean).join("\n");
  return <ExpandableRow item={item} iconName="comment" label="提问" summary={summary} summaryTitle={title || summary} />;
}
// 调试行：动作与目标（launch 程序 / file:line）
function renderDebug(item: ToolItem) {
  const args = item.args || {};
  const action = args.action ? String(args.action).replaceAll("_", " ") : "request";
  const target = args.program || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return <ExpandableRow item={item} iconName="monitor" label="调试" summary={target ? `${action} ${target}` : action} />;
}
// GitHub 行：操作与对象（repo/path/query/title）
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
// LSP 行：动作与符号/文件
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
// 记忆五件套（retain/recall/reflect/learn/memory_edit）共用一行
function renderMemory(item: ToolItem) {
  const args = item.args || {};
  const memories = Array.isArray(args.memories) ? args.memories : [];
  const first = memories[0]?.content || "";
  const summary =
    args.query || // recall/reflect：检索问题
    args.memory || // learn：经验教训
    first || // retain：首条记忆
    (args.id ? `${args.op || "update"} ${args.id}` : "") || // memory_edit：操作 + 记忆 id
    item.text ||
    "memory";
  const title = memories.length > 1 ? memories.map((m) => m?.content || "").filter(Boolean).join("\n") : "";
  return (
    <ExpandableRow
      item={item}
      iconName="memory"
      label="记忆"
      summary={memories.length > 1 ? `${summary} +${memories.length - 1}` : summary}
      summaryTitle={title}
    />
  );
}

// ---------- 工具设备行（write 到 xd://tui 等设备路由） ----------
// 设备调用没有文件 diff，展开显示调用参数与设备回包（复用通用内容卡）
// 设备指令里的 op/name（content 是设备调用的 JSON 参数）
function deviceCmd(item: ToolItem): Record<string, unknown> | null {
  const content = item.args?.content;
  if (typeof content !== "string" || !content.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // 畸形 JSON：不补摘要，展开卡里仍有原始参数可看
  }
}
// 组内行摘要：设备指令的 op + name（如 text verifystatus）
function deviceOpText(item: ToolItem) {
  const cmd = deviceCmd(item);
  return [cmd?.op, cmd?.name].filter((v) => typeof v === "string" && v).join(" ");
}
function deviceSummary(item: ToolItem) {
  return [deviceNameOf(item.args?.path), deviceOpText(item)].filter(Boolean).join(" · ");
}
function renderDevice(item: ToolItem) {
  return <ExpandableRow item={item} iconName="plugins" label="设备" summary={deviceSummary(item) || item.text || ""} />;
}

// ---------- 设备组（连续同设备调用合并，结构一比一抄终端组） ----------
// 展开状态：独立 WeakMap（以组内首个 item 为键，引用稳定跨重绘保留）
export const devExpand = new WeakMap<ToolItem, boolean>();

// 组内行 UI：op 摘要 + 展开箭头（图标在组标题上，与终端组内行同款）
function DeviceRowUI({ sub, open, onToggle }: { sub: ToolItem; open: boolean; onToggle: () => void }) {
  const detail = deviceOpText(sub) || sub.args?.path || sub.text || "";
  return (
    <div className="chg-item" style={{ cursor: "pointer" }} onClick={onToggle}>
      <span className="lbl">设备</span>
      <Ellip className="c-tx" title={detail}>{detail}</Ellip>
      {sub.running && <Spin />}
      <span className={"ed-arrow" + (open ? " open" : "")}>
        <Icon name="chevronRight" />
      </span>
    </div>
  );
}

// 组内一次设备调用 = 行 + 其内容卡展开体（展开态记在 sub.cmdExpanded 上），与终端组同款
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

// 「设备 · tui · N 次调用」标题行：连续同设备调用合并组，点击向下展开各次调用
function DeviceGroup({ subs }: { subs: ToolItem[] }) {
  useGroupExpandVersion(); // 组展开态在模块级 WeakMap 上,靠 groupExpand 通道 bump 触发重渲染
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
        <span className="lbl">{`设备 · ${dev} · ${subs.length} 次调用`}</span>
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
  const subs = (item.group ?? []) as ToolItem[]; // 同 renderCmdGroup:组成员必为 tool 条目
  return <DeviceGroup subs={subs} />;
}

function renderGenericTool(item: ToolItem) {
  return <div className="act">{item.name || item.text || ""}</div>;
}

// 工具名 → 标签种类映射（edit/change 的行渲染在 EditRow.tsx，本文件只做分发）
function toolKind(item: ToolItem) {
  if (item.group) {
    // 连续编辑/读取/终端事件合并组（name 在 items.tsx 分组时标好）
    if (item.name === "read") return "readgroup";
    if (item.name === "cmd") return "cmdgroup";
    if (item.name === "device") return "devicegroup";
    return "change";
  }
  const name = item.name || item.text || "";
  // ToolRow 只收 tool 条目(thinking role 在 items.tsx 已分流给 ThinkingRow),role 检查恒 false,略去
  if (name === "thinking") return "think";
  if (name === "bash" || name === "shell" || name === "eval") return "cmd";
  if (name === "hub") return "hub";
  if (name === "grep" || name === "ast-grep") return "grep";
  if (name === "glob") return "glob";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "todo") return "todo";
  if (name === "read") return "read";
  if (name === "web_search") return "websearch";
  if (name === "ask") return "ask";
  if (name === "debug") return "debug";
  if (name === "github") return "github";
  if (name === "lsp") return "lsp";
  if (name === "memory_edit" || name === "retain" || name === "recall" || name === "reflect" || name === "learn") return "memory";
  // 同 isDeviceEvent 语义(此处入参已是 ToolItem,类型守卫会把 else 支收窄成 never,故内联判定)
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
      // thinking role 在 items.tsx 已分流到 ThinkingRow；这里兜底 tool role 但 name 为 thinking 的条目
      return <ThinkingRow item={item} />;
    case "cmd":
      return renderCmd(item);
    case "hub":
      return renderHubTool(item);
    case "grep":
      return renderGrep(item);
    case "glob":
      return renderGlob(item);
    case "mcp":
      return renderMcp(item);
    case "todo":
      return renderTodo(item);
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
