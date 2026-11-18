// Host-side rewrite of the SDK's xd:// mount notice: one row per MCP server.
//
// The base renders one line per mounted device, so connecting an MCP server puts
// every minted `mcp__<server>_<tool>` in the prompt as its own line. A server
// mounts and unmounts as a unit (the UI cannot drop a single tool), so the host
// collapses those lines to one row per server before the request leaves, which is
// the shape upstream now renders itself (pi-coding-agent xdev-mount-notice.md).
// Delete this extension once the pinned base version ships that shape.
//
// Only the provider-bound copy changes: the journal keeps the per-tool notice, so
// resuming, branch replay and the frontend transcript still show what the base
// recorded.
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const NOTICE_TYPE = "xdev-mount-notice";
const INVENTORY_HEADER = "Available tools.";
const REMOVED_HEADER = "Unmounted; writes fail:";
/** A device row: `- xd://<name> — <summary>` or `- xd://<name>`. */
const DEVICE_LINE = /^- xd:\/\/(\S+?)(?:\s+—\s+.*)?$/;

/** Minimal surface this extension registers; the SDK's own types are brand-incompatible (same precedent as keepalive). */
interface XdevNoticePi {
  on(
    event: "context",
    handler: (event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined,
  ): void;
}

function serverRow(server: string, count: number, section: "added" | "removed"): string {
  const tools = `${count} tool${count === 1 ? "" : "s"}`;
  const label = `MCP server ${JSON.stringify(server)}: ${tools}`;
  return section === "added" ? `- ${label}, listed by \`read xd://\`` : `- ${label}`;
}

/**
 * Collapse the notice's MCP device rows to one row per server, leaving every
 * other device (and any already-collapsed row) untouched. First-seen order is
 * preserved, so a mixed delta still reads in mount order.
 */
export function rewriteXdevMountNotice(content: string, serverOf: (name: string) => string | undefined): string {
  if (!content.includes("xd:// device inventory changed.")) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let section: "added" | "removed" | undefined;
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (line.startsWith(INVENTORY_HEADER)) {
      section = "added";
    } else if (line.startsWith(REMOVED_HEADER)) {
      section = "removed";
    } else if (line === "</system-notice>" || line.startsWith("Configured inline device docs:") || line.startsWith("Read `xd://<tool>`")) {
      section = undefined;
    }
    const match = section === undefined ? null : DEVICE_LINE.exec(line);
    if (!match || section === undefined) {
      out.push(line);
      index++;
      continue;
    }
    // A run of device rows is one mount delta: group it before emitting.
    const delta = section;
    const rows: { name: string; line: string }[] = [];
    while (index < lines.length) {
      const row = DEVICE_LINE.exec(lines[index]!);
      if (!row) break;
      rows.push({ name: row[1]!, line: lines[index]! });
      index++;
    }
    const counts = new Map<string, number>();
    for (const row of rows) {
      const server = serverOf(row.name);
      if (server !== undefined) counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    const emitted = new Set<string>();
    for (const row of rows) {
      const server = serverOf(row.name);
      if (server === undefined) {
        out.push(row.line);
        continue;
      }
      if (emitted.has(server)) continue;
      emitted.add(server);
      out.push(serverRow(server, counts.get(server) ?? 1, delta));
    }
  }
  return out.join("\n");
}

const TOAST_PREFIX = "xd://: ";

/**
 * Collapse the base's session toast (`xd://: mounted a, b; unmounted c`) to one
 * entry per MCP server. The base builds it from minted tool names, so a server
 * that just connected enumerates its whole tool set in the UI strip.
 */
export function rewriteXdevMountNoticeToast(
  message: string,
  serverOf: (name: string) => string | undefined,
): string {
  if (!message.startsWith(TOAST_PREFIX)) return message;
  const segments = message.slice(TOAST_PREFIX.length).split("; ");
  const rewritten = segments.map((segment) => {
    const match = /^(mounted|unmounted) (.+)$/.exec(segment);
    if (!match) return segment;
    const names = match[2]!.split(", ").filter(Boolean);
    const counts = new Map<string, number>();
    for (const name of names) {
      const server = serverOf(name);
      if (server !== undefined) counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    if (counts.size === 0) return segment;
    const emitted = new Set<string>();
    const parts: string[] = [];
    for (const name of names) {
      const server = serverOf(name);
      if (server === undefined) {
        parts.push(name);
        continue;
      }
      if (emitted.has(server)) continue;
      emitted.add(server);
      const count = counts.get(server) ?? 1;
      parts.push(`${server} (${count} tool${count === 1 ? "" : "s"})`);
    }
    return `${match[1]} ${parts.join(", ")}`;
  });
  return TOAST_PREFIX + rewritten.join("; ");
}

/** Registers the mount-notice rewrite on the session's pre-LLM context hook. */
export function createXdevMountNoticeExtension(serverOf: (name: string) => string | undefined) {
  return (pi: XdevNoticePi): void => {
    pi.on("context", ({ messages }) => {
      let changed = false;
      const next = messages.map((message) => {
        if (message.role !== "custom" || message.customType !== NOTICE_TYPE) return message;
        if (typeof message.content !== "string") return message;
        const content = rewriteXdevMountNotice(message.content, serverOf);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      });
      return changed ? { messages: next } : undefined;
    });
  };
}
