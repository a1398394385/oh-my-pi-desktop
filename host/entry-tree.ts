// In-session entry tree projection (TUI /tree data source):
// SessionTreeNode forest (manager.getTree()) → frontend display nodes.
// Split out of translate.ts (row-limit).
import os from "node:os";
import { hostI18n } from "./i18n/host.ts";
import { stripDcpTags } from "./translate.ts";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

// ---------- In-session entry tree (TUI /tree data source) ----------
// SessionTreeNode forest (manager.getTree()) → frontend display nodes. Row
// text scope aligns with the base tree-selector's #getEntryDisplayText: a
// one-line summary per entry type, bookkeeping entries keep only the type
// label; the two kinds hidden in the default view (settings-kind entries /
// textless non-leaf assistants) are flagged with isSettings /
// emptyAssistant, and the filtering happens in the frontend (same filter
// semantics as the base). In the installed base this function lives at
// pi-tui/chat/transcript-entry (only newer versions moved it to
// session-context — follow the installed one)
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const TREE_SETTINGS_KINDS: Record<string, true> = {
  label: true,
  custom: true,
  model_change: true,
  model_usage: true,
  thinking_level_change: true,
  service_tier_change: true,
  title_change: true,
  credential_pin: true,
  session_init: true,
  ttsr_injection: true,
  mode_change: true,
  reset_boundary: true,
};

// AgentMessage is a union of Message + custom message unions with varying member fields; read uniformly as optional fields
function msgField(msg: unknown, key: string): unknown {
  return typeof msg === "object" && msg !== null && key in msg
    ? (msg as Record<string, unknown>)[key]
    : undefined;
}

// Single-line normalization: folds newlines/tabs to spaces, strips ANSI and control characters, caps length (right-pane row width is limited)
function treeNorm(s: unknown, max = 160): string {
  const t = String(s ?? "")
    .replace(/\x1b\[[0-9;:]*m/g, "")
    .replace(/[\n\t]/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Full-text variant for message-class rows: the host sends the complete text
// (line breaks kept); the collapsed row truncates via CSS single-line ellipsis
// and the expanded drawer is the full-content scrollable view.
function treeNormMulti(s: unknown): string {
  return String(s ?? "")
    .replace(/\x1b\[[0-9;:]*m/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

function treeContentText(content: unknown): string {
  if (typeof content === "string") return stripDcpTags(content);
  if (!Array.isArray(content)) return "";
  return stripDcpTags(
    content
      .map((b) => (msgField(b, "type") === "text" ? String(msgField(b, "text") ?? "") : ""))
      .filter(Boolean)
      .join(" "),
  );
}

// Tool call row summary (aligned with the base tree-selector
// #formatToolCall): a toolResult row shows its corresponding call
// (command/path/pattern), truncated with an ellipsis when too long, so the
// right pane tells at a glance what was done
function treeShortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function treeFormatToolCall(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => String(v ?? "");
  const pathOf = () => treeShortenPath(str(args.path || args.file_path));
  switch (name) {
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let display = pathOf();
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        display += `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`;
      }
      return `[read: ${display}]`;
    }
    case "write":
      return `[write: ${pathOf()}]`;
    case "edit":
      return `[edit: ${pathOf()}]`;
    case "bash":
      return `[bash: ${treeNorm(args.command, 50)}]`;
    case "grep": {
      const pattern = str(args.pattern);
      const scope = typeof args.path === "string" ? treeShortenPath(args.path) : ".";
      return `[grep: /${pattern}/ in ${scope}]`;
    }
    case "glob": {
      const scope = typeof args.path === "string" ? treeShortenPath(args.path) : ".";
      return `[glob: ${scope}]`;
    }
    case "ls":
      return `[ls: ${pathOf() || "."}]`;
    default: {
      const raw = JSON.stringify(args);
      return `[${name}: ${raw.slice(0, 40)}${raw.length > 40 ? "…" : ""}]`;
    }
  }
}

// Collect toolCall blocks from assistant message content across the whole
// tree: toolResult entries only carry toolCallId, and the row summary needs
// it to find the call's name/arguments back (same idea as the base's
// #flattenTree building a toolCallMap)
function collectToolCalls(roots: SessionTreeNode[]): Map<string, { name: string; args: Record<string, unknown> }> {
  const map = new Map<string, { name: string; args: Record<string, unknown> }>();
  const walk = (node: SessionTreeNode): void => {
    const entry = node.entry;
    if (entry.type === "message") {
      const content = msgField(entry.message, "content");
      if (Array.isArray(content)) {
        for (const b of content) {
          if (msgField(b, "type") !== "toolCall") continue;
          const id = msgField(b, "id");
          const name = msgField(b, "name");
          const args = msgField(b, "arguments");
          if (typeof id === "string" && typeof name === "string") {
            map.set(id, { name, args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {} });
          }
        }
      }
    }
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return map;
}

// Entry → row display text (a slimmed version aligned with the base tree-selector summary scope)
function treeEntryText(entry: SessionEntry, toolCalls: Map<string, { name: string; args: Record<string, unknown> }>): string {
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      const role = msgField(msg, "role");
      const content = treeContentText(msgField(msg, "content"));
      if (role === "toolResult") {
        const callId = msgField(msg, "toolCallId");
        const call = typeof callId === "string" ? toolCalls.get(callId) : undefined;
        if (call) return treeFormatToolCall(call.name, call.args);
        return `[${String(msgField(msg, "toolName") ?? "tool")}]`;
      }
      if (role === "bashExecution") return `[bash]: ${treeNorm(msgField(msg, "command"), 80)}`;
      if (role === "assistant") {
        if (content) return treeNormMulti(content);
        const err = msgField(msg, "errorMessage");
        if (typeof err === "string" && err) return treeNorm(err, 80);
        if (msgField(msg, "stopReason") === "aborted") return hostI18n.t("flows.tree.aborted");
        return "";
      }
      return treeNormMulti(content); // user / developer / other roles
    }
    case "custom_message":
      return treeNormMulti(treeContentText(entry.content));
    case "compaction":
      return `[compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens]`;
    case "branch_summary":
      return treeNormMulti(entry.summary);
    case "model_change":
      return `[model: ${entry.model}]`;
    case "model_usage":
      return `[model usage: ${entry.purpose ?? ""} ${entry.provider ?? ""}/${entry.model ?? ""}]`;
    case "thinking_level_change":
      return `[thinking: ${entry.thinkingLevel ?? "off"}]`;
    case "label":
      return `[label: ${entry.label ?? hostI18n.t("flows.tree.cleared")}]`;
    case "service_tier_change":
      return "[service tier]";
    case "title_change":
      return `[title: ${treeNorm(entry.title, 60)}]`;
    case "mode_change":
      return `[mode: ${entry.mode}]`;
    case "credential_pin":
      return `[credential pin: ${entry.provider}]`;
    default:
      return `[${entry.type.replaceAll("_", " ")}]`;
  }
}

export type EntryTreeNode = {
  id: string;
  kind: string; // entry.type
  role?: string; // message role (message entries only)
  text: string; // row display text
  label?: string; // user label (already resolved by the base's getTree)
  ts?: string; // entry.timestamp
  userReq?: boolean; // isUserRequestEntry: for the "user only" filter
  emptyAssistant?: boolean; // Textless non-leaf assistant: hidden by the default filter
  isSettings?: boolean; // bookkeeping entry: shown only in "all" mode
  children: EntryTreeNode[];
};

export function treeToDisplay(roots: SessionTreeNode[], leafId: string | null): EntryTreeNode[] {
  const toolCalls = collectToolCalls(roots);
  const walk = (node: SessionTreeNode): EntryTreeNode => {
    const entry = node.entry;
    const role = entry.type === "message" ? msgField(entry.message, "role") : undefined;
    const text = treeEntryText(entry, toolCalls);
    const isLeaf = entry.id === leafId;
    const out: EntryTreeNode = {
      id: entry.id,
      kind: entry.type,
      text,
      ts: entry.timestamp,
      children: node.children.map(walk),
    };
    if (typeof role === "string") out.role = role;
    if (node.label) out.label = node.label;
    if (isUserRequestEntry(entry)) out.userReq = true;
    if (TREE_SETTINGS_KINDS[entry.type]) out.isSettings = true;
    // Matching the base's default filter: a textless assistant that is neither error nor aborted (a pure tool-call container) is hidden by default, except the leaf
    if (role === "assistant" && !isLeaf && !text) {
      const sr = msgField(entry.message, "stopReason");
      if (sr === undefined || sr === "stop" || sr === "toolUse") out.emptyAssistant = true;
    }
    return out;
  };
  return roots.map(walk);
}
