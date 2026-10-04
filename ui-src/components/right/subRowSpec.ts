// Subagent tool-call row specs: tool name → icon + label + one-line summary, shared by the
// Agent Hub detail page's activity feed (HubDetailPage) — mirrors chat/ToolRow.tsx's
// toolKind dispatch. Labels are i18n keys (chat.*) resolved at render, except "MCP" / the
// raw tool-name fallback which are already display text.
import { uniqueFiles, splitPath } from "../chat/util";
import type { SubagentToolCall } from "../../types/session";

// args is an unknown host pass-through; row specs read only these string fields
type Args = {
  command?: string;
  path?: string;
  pattern?: string;
  query?: string;
  task?: string;
  op?: string;
  text?: string;
  memory?: string;
  sessionId?: string;
  fromTurn?: number;
  toTurn?: number;
};

export type RowSpec = { icon: string; label: string; summary: string };

function asArgs(call: SubagentToolCall): Args {
  return (call.args && typeof call.args === "object" ? call.args : {}) as Args;
}

export function rowSpec(call: SubagentToolCall): RowSpec {
  const a = asArgs(call);
  const name = call.name || "";
  const file = uniqueFiles(call.files?.length ? call.files : a.path ? [a.path] : [])[0] || "";
  if (name === "bash" || name === "shell" || name === "eval")
    return { icon: "termBox", label: "chat.labelTerminal", summary: a.command || "" };
  if (name === "grep" || name === "ast_grep")
    return { icon: "read", label: "chat.labelSearch", summary: [a.pattern, a.path ? splitPath(a.path).dir : ""].filter(Boolean).join("  ") };
  if (name === "glob")
    return { icon: "ftFile", label: "chat.labelGlob", summary: [a.pattern, a.path ? splitPath(a.path).dir : ""].filter(Boolean).join("  ") };
  if (name === "find")
    return { icon: "search", label: "chat.labelFind", summary: [a.query, a.path ? splitPath(a.path).dir : ""].filter(Boolean).join("  ") };
  if (name === "read") return { icon: "read", label: "chat.labelRead", summary: file };
  if (name === "edit" || name === "write" || name === "apply_patch")
    return { icon: "pencil", label: "chat.labelChange", summary: file };
  if (name === "todo") {
    const td = call.todo as { content?: string; done?: number; total?: number } | undefined;
    return { icon: "todo", label: "chat.labelTodo", summary: td?.content || a.task || "" };
  }
  if (name.startsWith("mcp__")) return { icon: "plug", label: "MCP", summary: name.split("__").slice(2).join("__") };
  if (name === "web_search") return { icon: "globe", label: "chat.labelWebSearch", summary: a.query || "" };
  if (name === "ask") return { icon: "comment", label: "chat.labelAsk", summary: "" };
  if (name === "read_session_context")
    return {
      icon: "search",
      label: "chat.labelSessionContext",
      summary: a.query || `${a.sessionId || ""}${a.fromTurn !== undefined || a.toTurn !== undefined ? ` · ${a.fromTurn ?? 0}–${a.toTurn ?? "end"}` : ""}`,
    };
  if (name === "memory_edit" || name === "retain" || name === "recall" || name === "reflect" || name === "learn")
    return { icon: "memory", label: "chat.labelMemory", summary: a.query || a.memory || "" };
  if (name === "hub") return { icon: "termBox", label: "chat.labelBackground", summary: a.command || a.op || a.text || "" };
  // Generic fallback: the tool name is the label, body carries everything
  return { icon: "plug", label: name || "tool", summary: "" };
}
