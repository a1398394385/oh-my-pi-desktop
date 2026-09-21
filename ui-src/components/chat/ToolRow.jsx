// 工具行：工具名 → 标签种类映射与各标签行渲染。迁移自 ui/tool-labels.js
// （renderToolItem/toolKind + 各 render 函数）。加减工具标签只改本文件。
import { notify } from "../../store.js";
import Icon from "../../Icon.jsx";
import { Ellip, FileChip, LinkedText, FadeBox, useLift, openReadFileInSidebar, uniqueFiles, splitPath } from "./parts.jsx";
import EditRow, { renderChange } from "./EditRow.jsx";
import ThinkingRow from "./ThinkingRow.jsx";

// ---------- 终端行（bash/shell/eval）与后台工具行（hub）：上命令、下输出的展开卡 ----------
function CmdCard({ command, item, lift }) {
  return (
    <div className={"cmd-card" + (lift ? " lift" : " drop")}>
      <FadeBox className="cmd-card-cmd">{command || "（无命令）"}</FadeBox>
      <FadeBox className="cmd-card-out" as="pre">
        {item.output || (item.running ? "运行中…" : "（无输出）")}
      </FadeBox>
    </div>
  );
}
function CmdRow({ item, command, iconSize, iconLabel }) {
  const [closing, close] = useLift();
  const toggle = () => {
    if (item.cmdExpanded) close(() => { item.cmdExpanded = false; notify(); });
    else {
      item.cmdExpanded = true;
      notify();
    }
  };
  return (
    <>
      <div className="cmd" style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="c-ic"><Icon name="termBox" size={iconSize} />{iconLabel}</span>
        <Ellip className="c-tx" title={command}>{command || ""}</Ellip>
        {item.running && <span className="cmd-spin" />}
        <span className={"ed-arrow" + (item.cmdExpanded ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {item.cmdExpanded && <CmdCard command={command} item={item} lift={closing} />}
    </>
  );
}
function renderCmd(item) {
  return (
    <CmdRow
      item={item}
      command={item.args?.command || item.text || ""}
      iconSize={14}
      iconLabel={item.name === "eval" ? "求值" : "终端"}
    />
  );
}
// hub 摘要：op + 目标 + 参数/命令/文本（与终端行同一交互，标签为「后台」、图标 13）
function hubSummary(args) {
  const op = args.op || "hub";
  const target = args.name || args.application || "";
  let summary = `hub ${op}${target ? " " + target : ""}`;
  if (args.application && Array.isArray(args.args)) summary += `: ${args.application} ${args.args.join(" ")}`;
  else if (args.command) summary += `: ${args.command}`;
  else if (args.text) summary += `: ${args.text}`;
  return summary;
}
function renderHubTool(item) {
  return <CmdRow item={item} command={hubSummary(item.args || {})} iconSize={13} iconLabel="后台" />;
}

// ---------- 待办行 ----------
function renderTodo(item) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  return (
    <div className="act todo">
      <Icon name="todo" />
      <span className="lbl">待办</span>
      <Ellip className="td-tx" title={content}>{content}</Ellip>
      {td && td.total > 0 && <span className="td-n">{`${td.done}/${td.total}`}</span>}
    </div>
  );
}

// ---------- 读取行：文件名可点击（读到过文本内容时右栏文件视图按行号范围展示） ----------
function renderRead(item) {
  const path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  const { dir, name } = splitPath(path);
  return (
    <div className="act read">
      <Icon name="read" />
      <span className="lbl">读取</span>
      {path ? (
        <>
          <FileChip
            path={path}
            nameClass={item.details?.displayContent?.text ? "ed-name" : ""}
            onNameClick={item.details?.displayContent?.text ? () => openReadFileInSidebar(item, path) : undefined}
          />
          {" "}
          {dir && <Ellip className="path" title={path}>{dir}</Ellip>}
        </>
      ) : (
        item.text || "read"
      )}
    </div>
  );
}

// ---------- grep / glob 行：模式串 + 目录（截断省略） ----------
function renderGrep(item) {
  const pat = item.args?.pattern || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  return (
    <div className="act read">
      <Icon name="read" />
      <span className="lbl">搜索</span>
      <Ellip className="path" title={pat}>{pat}</Ellip>
      {dir && <Ellip className="path">{dir}</Ellip>}
    </div>
  );
}
function renderGlob(item) {
  const pat = item.args?.pattern || item.text || "";
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  return (
    <div className="act read">
      <Icon name="ftFile" />
      <span className="lbl">查找</span>
      <Ellip className="path" title={pat}>{pat}</Ellip>
      {dir && <Ellip className="path">{dir}</Ellip>}
    </div>
  );
}

// ---------- MCP 行 ----------
function renderMcp(item) {
  const tool = String(item.name || "").split("__").slice(2).join("__");
  return (
    <div className="act mcp">
      <Icon name="plug" />
      <span className="lbl">MCP</span>
      {tool && <Ellip className="path" title={item.name}>{` ${tool}`}</Ellip>}
    </div>
  );
}

// ---------- 可展开标签行：图标 + 中文标签 + 摘要，点击向下展开 参数+结果 卡片 ----------
function truncateText(s, max = 4000) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + ` …(截断,共${s.length}字)` : s;
}
// ask 的 questions 结构化展示（问题 + 选项，★ 推荐项），其余工具是 args JSON
function AskArgs({ questions }) {
  return (
    <div className="cmd-card-cmd ask-args">
      {questions.map((q, i) =>
        !q || typeof q !== "object" ? null : (
          <div className="ask-q" key={i}>
            <div className="ask-q-t">
              {`${i + 1}. ${q.question || ""}${q.multi ? "（多选）" : ""}`}
              {q.header && <span className="ask-q-h">{q.header}</span>}
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
function ContentCard({ item, lift }) {
  const detailText = item.details?.displayContent?.text;
  const outText =
    item.output ||
    detailText ||
    (item.details ? truncateText(JSON.stringify(item.details, null, 2)) : "") ||
    (item.running ? "运行中…" : "（无输出）");
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
        <LinkedText text={outText} />
      </FadeBox>
    </div>
  );
}
function ExpandableRow({ item, iconName, label, summary, summaryTitle }) {
  const [closing, close] = useLift();
  const toggle = () => {
    if (item.cmdExpanded) close(() => { item.cmdExpanded = false; notify(); });
    else {
      item.cmdExpanded = true;
      notify();
    }
  };
  return (
    <>
      <div className="act read" style={{ cursor: "pointer" }} onClick={toggle}>
        <Icon name={iconName} />
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
function renderWebSearch(item) {
  return <ExpandableRow item={item} iconName="globe" label="联网搜索" summary={item.args?.query || item.text || ""} />;
}
// 提问行：首个问题（多个时 +N），title 为完整问题列表
function renderAsk(item) {
  const qs = Array.isArray(item.args?.questions) ? item.args.questions : [];
  const first = qs[0]?.question || item.text || "";
  const summary = qs.length > 1 ? `${first} +${qs.length - 1}` : first;
  const title = qs.map((q) => q?.question || "").filter(Boolean).join("\n");
  return <ExpandableRow item={item} iconName="comment" label="提问" summary={summary} summaryTitle={title || summary} />;
}
// 调试行：动作与目标（launch 程序 / file:line）
function renderDebug(item) {
  const args = item.args || {};
  const action = args.action ? String(args.action).replaceAll("_", " ") : "request";
  const target = args.program || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return <ExpandableRow item={item} iconName="monitor" label="调试" summary={target ? `${action} ${target}` : action} />;
}
// GitHub 行：操作与对象（repo/path/query/title）
function renderGithub(item) {
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
function renderLsp(item) {
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
function renderMemory(item) {
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

function renderGenericTool(item) {
  return <div className="act">{item.name || item.text || ""}</div>;
}

// 工具名 → 标签种类映射（edit/change 的行渲染在 EditRow.jsx，本文件只做分发）
function toolKind(item) {
  if (item.group) return "change"; // 连续编辑事件合并组
  const name = item.name || item.text || "";
  if (item.role === "thinking" || name === "thinking") return "think";
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
  if (name === "edit" || name === "write" || name === "apply_patch") {
    const n = uniqueFiles(item.files || item.args?.files || (item.args?.path ? [item.args.path] : [])).length;
    return n > 1 ? "change" : "edit";
  }
  return "generic";
}

export default function ToolRow({ item }) {
  switch (toolKind(item)) {
    case "think":
      // thinking role 在 items.jsx 已分流到 ThinkingRow；这里兜底 tool role 但 name 为 thinking 的条目
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
    case "read":
      return renderRead(item);
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
    case "change":
      return renderChange(item);
    case "edit":
      return <EditRow item={item} />;
    default:
      return renderGenericTool(item);
  }
}
