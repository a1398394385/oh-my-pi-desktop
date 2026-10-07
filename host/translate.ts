// omp events → frontend narrow-event translate layer: the frontend only knows
// these UiEvent kinds and does not depend on omp event shape details.
// The live stream (translateEvent) and the disk history (entriesToTranscript)
// share the same tool-entry summary logic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editDiffString } from "@oh-my-pi/pi-natives";
import { hostI18n } from "../ui-src/i18n/host.ts";
import type { TurnUsage, TranscriptItem, PoolEntry } from "./state.ts";
import { REF_TAG_RE } from "./acp-context.ts";

// In-flight write tool snapshot before mutation: caches the pre-write text to
// generate an accurate diff between the old and new file contents when the
// tool completes, avoiding whole-file addition fallbacks for existing files.
const pendingWrites = new Map<string, { path: string; oldText?: string }>();


// Strip the <dcp-message-id> tags injected/replayed by ACP: disk keeps the
// original text (historical fact); scrub uniformly before pushing to the UI.
// Brief flashes during live text_delta streaming are handled by the frontend
// render layer (AssistantMsg).
function stripDcpTags(s: string): string {
	const out = s.replace(REF_TAG_RE, "");
	return out === s ? s : out.trim();
}

export type UiEvent =
  | { kind: "turn_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking"; phase: "start" | "end"; durationLabel?: string; thinking?: string; expandable?: boolean }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool"; name: string; toolCallId?: string; args?: Record<string, unknown>; files?: string[]; intent?: string }
  | { kind: "tool_update"; name: string; toolCallId?: string; files?: string[]; added?: number; removed?: number; todo?: TranscriptItem["todo"]; output?: string; details?: unknown; diffContent?: string }
  | { kind: "turn_end"; usage?: TurnUsage | null; userEntryId?: string; assistantEntryId?: string; runEnd?: boolean }
  | { kind: "thinking_level"; configured?: string; resolved?: string }
  | { kind: "error"; text: string } // provider/request failure (quota, auth, transport)
  | { kind: "mention"; files: string[] }; // @ mention read-back (sent directly by the agent_end scan in attachEntry, not via translateEvent)

// Tool device paths (xd://tui, xd://mcp__xxx, ...): reading/writing one invokes a device, not a file read/write
function isDevicePath(p: unknown): boolean {
  return typeof p === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
}

function pathOf(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return "";
}

// The desktop edit tool addresses its target as an "[path#TAG]" header line inside
// args.input (not args.path) — extract the path so the change row/group shows the file
function editInputPath(input: unknown): string {
  if (typeof input !== "string") return "";
  const m = /^\[([^\[\]#\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/m.exec(input);
  return m ? m[1].trim() : "";
}

function collectFiles(name: string, args: any, details?: any): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p !== "string" || !p) return;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm; // Relative and absolute paths count as the same file; keep the more complete one
  };
  if (Array.isArray(args?.edits)) for (const e of args.edits) push(e?.path ?? e?.file_path);
  if (Array.isArray(args?.paths)) for (const p of args.paths) push(p);
  if (Array.isArray(args?.files)) for (const f of args.files) push(f);
  if (Array.isArray(details?.files)) for (const f of details.files) push(f);
  if (typeof args?.input === "string" && (name === "apply_patch" || name === "edit")) {
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.input))) push(m[1].trim());
  }
  if (name === "edit") {
    const p = editInputPath(args?.input);
    if (p) push(p);
  }
  if (Array.isArray(details?.perFileResults)) for (const f of details.perFileResults) push(f?.path);
  if (Array.isArray(details?.hits)) for (const h of details.hits) push(h?.rel);
  if (typeof details?.path === "string") push(details.path);
  if (typeof details?.resolvedPath === "string") push(details.resolvedPath);
  const p = pathOf(args);
  if (p) push(p);
  return out;
}

function toolArgsForUi(name: string, args: any): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  if (name === "bash" || name === "shell") return { command: String(args.command ?? "").slice(0, 4000) };
  if (name === "eval") return { command: String(args.code ?? args.command ?? "").slice(0, 4000) }; // JS evaluation, rendered as a terminal card
  if (name === "grep" || name === "ast_grep") return { pattern: String(args.pattern ?? args.query ?? args.pat ?? "").slice(0, 500), path: pathOf(args) };
  if (name === "glob") return { pattern: String(args.pattern ?? "").slice(0, 500), path: pathOf(args) };
  if (name === "find") {
    return {
      query: String(args.query ?? "").slice(0, 500),
      grep_keywords: Array.isArray(args.grep_keywords) ? args.grep_keywords.map(String).slice(0, 20) : undefined,
      path: pathOf(args),
    };
  }
  if (name === "web_search") return { query: String(args.query ?? "").slice(0, 1000) };
  if (name === "read_session_context") return { query: args.query, sessionId: args.sessionId, fromTurn: args.fromTurn, toTurn: args.toTurn };
  if (name === "ask") return { questions: capValue(args.questions) };
  if (name === "debug") {
    return { action: args.action, program: args.program, file: args.file, line: args.line, function: args.function, expression: args.expression };
  }
  if (name === "github") {
    return { op: args.op, repo: args.repo, branch: args.branch, path: args.path, pr: args.pr, query: args.query, title: args.title, base: args.base, head: args.head };
  }
  if (name === "lsp") {
    return { action: args.action, file: args.file, line: args.line, symbol: args.symbol, query: args.query, new_name: args.new_name };
  }
  if (name === "retain") return { memories: capValue(args.memories) };
  if (name === "recall" || name === "reflect") return { query: args.query };
  if (name === "learn") return { memory: args.memory, skill: args.skill?.name };
  if (name === "memory_edit") return { op: args.op, id: args.id };
  if (name === "todo") return { op: args.op, task: args.task, i: args.i };
  if (name === "task") {
    // Subagent spawn: the assignment text (flat task / batch context) is the card's main content;
    // per-item task text capped individually so one big item cannot swallow the whole frame
    return {
      name: args.name,
      agent: args.agent,
      task: typeof args.task === "string" ? args.task.slice(0, 20_000) : undefined,
      context: typeof args.context === "string" ? args.context.slice(0, 20_000) : undefined,
      tasks: Array.isArray(args.tasks)
        ? args.tasks.map((it) => ({
            name: it?.name,
            agent: it?.agent,
            isolated: it?.isolated,
            task: typeof it?.task === "string" ? it.task.slice(0, 8000) : undefined,
          }))
        : undefined,
    };
  }
  if (name === "hub") {
    return {
      op: args.op,
      name: args.name,
      application: args.application,
      args: args.args,
      text: args.text,
      cwd: args.cwd,
      i: args.i,
      pty: args.pty,
      to: args.to,
      message: args.message,
    };
  }
  const files = collectFiles(name, args);
  const path = pathOf(args) || (name === "edit" ? editInputPath(args?.input) : "");
  const out: Record<string, unknown> = {};
  if (path) out.path = path;
  if (files.length) out.files = files;
  if (typeof args.content === "string") out.content = args.content.slice(0, 8000);
  return out;
}

// Structured params (ask.questions / retain.memories etc.) over the cap degrade to a truncated JSON string, protecting the WebSocket frame
function capValue(v: unknown, max = 8000): unknown {
  if (v === undefined) return v;
  const s = JSON.stringify(v) ?? "";
  return s.length > max ? s.slice(0, max) : v;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function thinkingLabel(sec: number): string {
  if (sec < 5) return hostI18n.t("flows.think.durationFew");
  if (sec < 60) return hostI18n.t("flows.think.durationSec", { n: sec });
  return hostI18n.t("flows.think.durationMinSec", { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, "0") });
}

// Tool result text: joins the text segments of result.content (truncated; details go through the artifact)
function resultText(result: unknown, max = 20_000): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (p): p is { type: string; text: string } =>
        !!p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim()
    .slice(0, max);
}

function summarizeResult(name: string, args: any, result: any, pendingWrite?: { path: string; oldText?: string }): Partial<TranscriptItem> {
  const details = result?.details ?? (result && typeof result === "object" && "diff" in result ? result : undefined);
  const patch: Partial<TranscriptItem> = {};
  const files = collectFiles(name, args, details);
  if (files.length) patch.files = files;
  if (name === "read") {
    // Pass through the TUI-style render data: displayContent is the original text the model saw (no line-number prefix), the line range comes from truncation.shownRange
    const dc = details?.displayContent;
    if (dc && typeof dc.text === "string" && dc.text) {
      const MAX = 200_000; // A realistic bound for WebSocket transport and frontend rendering; a normal read (self-truncating) stays far below
      let text = dc.text;
      let lineNumbers = Array.isArray(dc.lineNumbers) ? dc.lineNumbers : undefined;
      if (text.length > MAX) {
        text = text.slice(0, MAX);
        const n = text.split("\n").length;
        if (lineNumbers) lineNumbers = lineNumbers.slice(0, n);
      }
      patch.details = {
        isDirectory: details.isDirectory === true,
        displayContent: { text, startLine: dc.startLine, lineNumbers },
        totalLines: details.totalLines,
        resolvedPath: details.resolvedPath ?? (details.meta?.source?.type === "path" ? details.meta.source.value : undefined),
        shownRange: details.meta?.truncation?.shownRange,
        // Summarized reads (elided body): the only "partial read" marker with no
        // truncation/lineNumbers; the frontend derives the shown range from it
        summary: typeof details.summary?.lines === "number" ? details.summary : undefined,
      };
    }
    // Directory-read fallback: carry isDirectory even without displayContent (the frontend filters the browsed group by it)
    else if (details?.isDirectory) patch.details = { isDirectory: true };
  }
  if (name === "bash" || name === "shell" || name === "eval") {
    // Terminal/eval tools: carry the output text for the frontend's expandable card (truncated; details go through the artifact)
    const text = resultText(result);
    if (text) patch.output = text;
    return patch;
  }
  if (name === "hub") {
    const text = resultText(result);
    if (text) patch.output = text;
    if (details) patch.details = details;
    return patch;
  }
  if (name === "wait") {
    // Coordination wait: the frontend's wait row summarizes details.jobs/agents; the model-facing
    // text (consumed peer message / nothing-to-wait notice) feeds the expandable card
    const text = resultText(result);
    if (text) patch.output = text;
    if (details) patch.details = details;
    return patch;
  }
  if (name === "task") {
    // Subagent spawn: details carry results/progress/async state for the expandable card
    const text = resultText(result);
    if (text) patch.output = text;
    if (details) patch.details = details;
    return patch;
  }
  if (name === "todo") {
    const tasks = (details?.phases ?? []).flatMap((p: any) => p.tasks ?? []);
    const done = tasks.filter((t: any) => t.status === "completed").length;
    const cur = tasks.find((t: any) => t.status === "in_progress") ?? tasks[0];
    patch.todo = {
      content: String(args?.task || cur?.content || args?.i || ""),
      done,
      total: tasks.length,
    };
    return patch;
  }
  // Tagged tools (find / web search / ask / debug / GitHub / LSP / the memory suite): result text feeds the frontend's expandable card
  if (
    name === "find" ||
    name === "web_search" || name === "ask" || name === "debug" || name === "github" || name === "lsp" ||
    name === "read_session_context" ||
    name === "retain" || name === "recall" || name === "reflect" || name === "learn" || name === "memory_edit"
  ) {
    const text = resultText(result);
    if (text) patch.output = text;
    if (details) patch.details = details;
    return patch;
  }
  if (Array.isArray(details?.perFileResults) && details.perFileResults.length > 1) {
    if (typeof details?.diff === "string") {
      patch.diffContent = details.diff.slice(0, 500_000);
    }
    if (details) patch.details = details;
    return patch; // Multi-file "changes" carry no line counts
  }
  if (typeof details?.diff === "string") {
    Object.assign(patch, diffStats(details.diff));
    // Carry the tool's real modification for this call too: the edit row's
    // inline expansion renders it directly (for a new file / no git baseline,
    // git diff can only show the whole thing as additions, mismatching the
    // +N-M summary); truncation cap matches the file_diff reply's scope
    patch.diffContent = details.diff.slice(0, 500_000);
  }
  else if (name === "write" && typeof args?.content === "string") {
    // Writing a tool device (xd://tui etc.) is not a file edit: there is no
    // file diff to show, and add/remove counts derived from content line
    // counts would be fake — send the device's reply text instead, for the
    // device row's expansion
    if (isDevicePath(args?.path)) {
      const text = resultText(result);
      if (text) patch.output = text;
    } else {
      const newText = args.content;
      const targetPath = pendingWrite?.path ?? pathOf(args);
      if (pendingWrite?.oldText !== undefined) {
        try {
          const diffRes = editDiffString(pendingWrite.oldText, newText, targetPath);
          if (diffRes?.diff) {
            Object.assign(patch, diffStats(diffRes.diff));
            patch.diffContent = diffRes.diff.slice(0, 500_000);
          } else {
            patch.added = 0;
            patch.removed = 0;
            patch.diffContent = "";
          }
        } catch {
          patch.added = Math.max(1, newText.split("\n").length);
          patch.removed = 0;
        }
      } else {
        patch.added = Math.max(1, newText.split("\n").length);
        patch.removed = 0;
        try {
          const diffRes = editDiffString("", newText, targetPath);
          if (diffRes?.diff) {
            patch.diffContent = diffRes.diff.slice(0, 500_000);
          }
        } catch {}
      }
    }
  }
  else if (name === "edit" && typeof args?.content === "string") {
    if (isDevicePath(args?.path)) {
      const text = resultText(result);
      if (text) patch.output = text;
    } else {
      patch.added = Math.max(1, args.content.split("\n").length);
      patch.removed = 0;
    }
  }
  return patch;
}

function isJunkPlaceholderText(text?: string | null): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

// user message content (string or blocks) → plain text, same extraction scope as the base's branch()
function userEntryText(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
}

// At agent_end this round's user messages are necessarily persisted: align
// and backfill the transcript's user entries lacking entryId against the
// user messages in the disk entries by text (the base's event stream carries
// no entry id, so alignment can only happen after the fact; hidden
// companion/system-injected messages have different text, so equality
// matching naturally skips them; the from pointer preserves order, so
// duplicate texts still line up). Returns the last entryId backfilled this
// round (for the turn_end event's incremental delivery), or undefined when
// there was nothing to backfill.
export function backfillUserEntryIds(entry: PoolEntry): string | undefined {
  const pending = entry.transcript.filter((t) => t.role === "user" && !t.entryId);
  if (pending.length === 0) return undefined;
  const users = (entry.manager?.getEntries() ?? [])
    .filter((e: any) => e?.type === "message" && e.message?.role === "user")
    .map((e: any) => ({ id: e.id as string, text: userEntryText(e.message.content) }));
  let last: string | undefined;
  let from = 0;
  for (const item of pending) {
    const hit = users.findIndex((u, i) => i >= from && u.text === item.text);
    if (hit < 0) continue; // Not yet persisted (still queued); backfill next turn_end
    item.entryId = users[hit].id;
    from = hit + 1;
    last = item.entryId;
  }
  return last;
}

// At agent_end this round's assistant messages are also persisted: align and
// backfill the transcript's assistant entries lacking entryId this round
// against the disk assistant entries in order (the event stream carries no
// entry id, same scope as backfillUserEntryIds). With this round's user
// anchor present, both pending and candidates start after it — historical
// same-text entries cannot be mismatched; if the anchor is not yet
// persisted, skip this round and wait for the next turn_end. Without an
// anchor (orphan assistants), pending is necessarily the newest batch,
// aligned with the candidates' tail. Returns the last entryId backfilled
// this round (the addressing key for the fork button on the round-final
// output), or undefined when there was nothing to backfill.
export function backfillAssistantEntryIds(entry: PoolEntry, afterUserId?: string): string | undefined {
  const all = entry.transcript;
  const raw: SessionEntry[] = entry.manager?.getEntries() ?? [];
  let tFrom = 0;
  let dFrom = 0;
  if (afterUserId) {
    const ui = all.findIndex((t) => t.role === "user" && t.entryId === afterUserId);
    const di = raw.findIndex((e) => e.id === afterUserId);
    if (ui < 0 || di < 0) return undefined;
    tFrom = ui + 1;
    dFrom = di + 1;
  }
  const pending = all.slice(tFrom).filter((t) => t.role === "assistant" && !t.entryId);
  if (pending.length === 0) return undefined;
  const cands = raw
    .slice(dFrom)
    .filter((e) => e.type === "message" && e.message.role === "assistant" && !isErrorOnlyMessage(e.message))
    .map((e) => e.id);
  const offset = afterUserId ? 0 : Math.max(0, cands.length - pending.length);
  let last: string | undefined;
  for (let i = 0; i < pending.length; i++) {
    const id = cands[offset + i];
    if (!id) break; // Not yet persisted (still queued); backfill next turn_end
    pending[i].entryId = id;
    last = id;
  }
  return last;
}

function flushAssistantDraft(entry: PoolEntry) {
  if (!entry.assistantDraft) return;
  const draft = stripDcpTags(entry.assistantDraft);
  if (!isJunkPlaceholderText(draft)) {
    entry.transcript.push({ role: "assistant", text: draft });
  }
  entry.assistantDraft = "";
}

// Failure text of an assistant message. A failed model request (quota / auth /
// transport) is persisted as an assistant message whose payload is only the
// `errorMessage` field — `content` is empty, so it carries no UI row of its own.
// That field is the single source for the error row in both live and reload paths.
function errorTextOf(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, stopReason, errorMessage } = msg as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (role !== "assistant" || stopReason !== "error") return null;
  const text = typeof errorMessage === "string" ? errorMessage.trim() : "";
  return text.length > 0 ? text : null;
}

// Whether an assistant entry yields no UI row (pure error message, no text).
// Used to keep the entryId backfill aligned: such entries exist on disk but not
// in the transcript, so they must not consume a backfill slot.
function isErrorOnlyMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const { stopReason, content } = msg as { stopReason?: unknown; content?: unknown };
  if (stopReason !== "error") return false;
  const blocks = Array.isArray(content) ? content : [];
  return !blocks.some((b) => {
    if (typeof b !== "object" || b === null) return false;
    const block = b as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

function uiToolPayload(item: TranscriptItem): Extract<UiEvent, { kind: "tool" }> {
  return { kind: "tool", name: item.name ?? item.text, toolCallId: item.toolCallId, args: item.args, files: item.files, intent: item.intent };
}

// Sum the token usage of all assistant messages of this run (agent_end.messages only contains what this run added, not the loaded history)
function sumRunUsage(messages: any[]): TurnUsage | null {
  let out: TurnUsage | null = null;
  for (const m of messages ?? []) {
    if (m?.role !== "assistant" || !m.usage) continue;
    out = out ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    out.input += m.usage.input || 0;
    out.output += m.usage.output || 0;
    out.cacheRead += m.usage.cacheRead || 0;
    out.cacheWrite += m.usage.cacheWrite || 0;
  }
  return out;
}

export function translateEvent(ev: any, entry: PoolEntry): UiEvent | null {
  switch (ev.type) {
    case "turn_start":
      // The true start of each model turn inside a run (continuation turns
      // from consuming queued messages also pass through here): the turn
      // boundary is the server's authoritative projection (same semantics as
      // ZCode's turnHeader); the UI must not re-guess it from the run-level
      // approximation of agent_start/agent_end — that is the root cause of
      // queued-consumption continuation turns being invisible to the UI
      return { kind: "turn_start" };
    case "turn_end": {
      // The true end of each model turn inside a run: seals this turn's
      // process. usage only takes this turn's assistant messages; whole-run
      // usage, userEntryId backfill, and list refresh are the runEnd frame's
      // job (mapped from agent_end)
      const u = ev.message?.usage;
      return {
        kind: "turn_end",
        runEnd: false,
        usage: u
          ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }
          : null,
      };
    }
    case "thinking_level_changed":
      // auto-resolution frame: when configured==="auto", resolved is the
      // level picked for this turn (the provisional frame emitted when
      // switching into auto has no resolved); manual-switch frames have no
      // configured. Pass through only; the frontend decides display.
      return { kind: "thinking_level", configured: ev.configured, resolved: ev.resolved };
    case "message_end": {
      // A failed request emits an error assistant message (stopReason "error",
      // payload only in `errorMessage`); text streamed before the failure is
      // settled first so the error row lands after it. Without this branch the
      // failure never reaches the UI: no text_delta ever carried it.
      const text = errorTextOf(ev.message);
      if (!text) return null;
      flushAssistantDraft(entry);
      entry.transcript.push({ role: "error", text });
      return { kind: "error", text };
    }
    case "message_update": {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === "text_delta") {
        entry.assistantDraft += ame.delta;
        return { kind: "text_delta", text: ame.delta };
      }
      if (ame?.type === "thinking_start") {
        flushAssistantDraft(entry);
        entry.thinkingDraft = "";
        entry.thinkingStartedAt = Date.now();
        entry.transcript.push({ role: "thinking", text: hostI18n.t("flows.think.label") });
        return { kind: "thinking", phase: "start" };
      }
      if (ame?.type === "thinking_delta") {
        entry.thinkingDraft += ame.delta ?? "";
        // hideThinkingBlock only affects the UI's default expansion, not data delivery: deltas still forward for streaming display
        return { kind: "thinking_delta", text: ame.delta ?? "" };
      }
      if (ame?.type === "thinking_end") {
        const last = [...entry.transcript].reverse().find((t) => t.role === "thinking");
        const thinking = (ame.content || entry.thinkingDraft || "").trim();
        const sec = entry.thinkingStartedAt ? Math.max(1, Math.round((Date.now() - entry.thinkingStartedAt) / 1000)) : 0;
        const durationLabel = thinkingLabel(sec);
        if (last) {
          last.text = hostI18n.t("flows.think.with", { duration: durationLabel });
          last.thinking = thinking;
          last.expandable = thinking.length > 0;
        }
        entry.thinkingDraft = "";
        entry.thinkingStartedAt = null;
        return { kind: "thinking", phase: "end", durationLabel, thinking, expandable: thinking.length > 0 };
      }
      return null;
    }
    case "tool_execution_start": {
      flushAssistantDraft(entry);
      if (ev.toolName === "write" && ev.toolCallId) {
        const p = pathOf(ev.args);
        if (p && !isDevicePath(p)) {
          const abs = path.resolve(entry.cwd, p);
          try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= 2_000_000) {
              pendingWrites.set(ev.toolCallId, { path: abs, oldText: fs.readFileSync(abs, "utf8") });
            } else {
              pendingWrites.set(ev.toolCallId, { path: abs });
            }
          } catch {
            pendingWrites.set(ev.toolCallId, { path: abs });
          }
        }
      }
      const args = toolArgsForUi(ev.toolName, ev.args);
      // intent: the `i` field the model wrote in the tool args (agent-loop already extracted it
      // into a string and stripped it from args); kept on the item for the working status row
      // and the wait row's param card
      const intent = typeof ev.intent === "string" && ev.intent.trim() ? ev.intent.trim() : undefined;
      const item: TranscriptItem = {
        role: "tool",
        text: ev.toolName,
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        args,
        files: collectFiles(ev.toolName, ev.args),
        intent,
      };
      entry.transcript.push(item);
      return uiToolPayload(item);
    }
    case "tool_execution_end": {
      const item =
        entry.transcript.findLast?.((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.name === ev.toolName);
      const pendingWrite = ev.toolCallId ? pendingWrites.get(ev.toolCallId) : undefined;
      if (ev.toolCallId) pendingWrites.delete(ev.toolCallId);
      if (item) Object.assign(item, summarizeResult(ev.toolName, { ...(item.args || {}), ...(ev.args || {}) }, ev.result, pendingWrite));
      return {
        kind: "tool_update",
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        files: item?.files,
        added: item?.added,
        removed: item?.removed,
        todo: item?.todo,
        output: item?.output,
        details: item?.details,
        diffContent: item?.diffContent, // The edit row's inline expansion prefers the real diff from this call's reply
      };
    }
    case "agent_end":
      // isTerminal === false means maintenance/async delivery will keep running; not a true end
      if (ev.isTerminal === false) return null;
      flushAssistantDraft(entry);
      const userEntryId = backfillUserEntryIds(entry);
      return {
        kind: "turn_end",
        runEnd: true,
        usage: sumRunUsage(ev.messages),
        userEntryId,
        assistantEntryId: backfillAssistantEntryIds(entry, userEntryId),
      };
    default:
      return null;
  }
}

// Phase separator row text for background long-running commands:
// [in-progress, done]. In-progress comes from the host's transient frame,
// done is translated from the disk trace (compaction / title_change
// entries) — both ends share this table.
// Getters translate on every read so a language switch is picked up
// immediately (module-load-time constants would freeze the startup language).
export const PHASE_TEXT: Record<string, [string, string]> = {
  get compact() {
    return [hostI18n.t("flows.phase.compactActive"), hostI18n.t("flows.phase.compactDone")];
  },
  get handoff() {
    return [hostI18n.t("flows.phase.handoffActive"), hostI18n.t("flows.phase.handoffDone")];
  },
  get rename() {
    return [hostI18n.t("flows.phase.renameActive"), hostI18n.t("flows.phase.renameDone")];
  },
};

// Disk history entries → frontend transcript (thinking blocks expandable;
// tools carry path/command/line counts)
// Turn grouping: one user message opens a turn; the turn's thinking/tool/
// intermediate assistant items are collected into a loop group (displayed
// collapsed), leaving only the last assistant text outside the group as the
// turn's outward result — matching the live turn_end collapse behavior.
export function entriesToTranscript(entries: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  const fileHistory = new Map<string, string>();
  let run: { items: TranscriptItem[]; usage: TurnUsage | null; startMs: number; endMs: number } | null = null;

  const finalizeRun = () => {
    if (!run) return;
    const r = run;
    run = null;
    let lastA = -1;
    for (let i = r.items.length - 1; i >= 0; i--) {
      if (r.items[i].role === "assistant") {
        lastA = i;
        break;
      }
    }
    const finalOut = lastA >= 0 ? r.items.splice(lastA, 1) : [];
    if (r.items.length) {
      out.push({
        role: "loop",
        text: "",
        collapsed: true,
        items: r.items,
        durationSec: Math.max(1, Math.round((r.endMs - r.startMs) / 1000)),
        usage: r.usage,
      });
    }
    out.push(...finalOut);
  };

  for (const e of entries) {
    // Execution-trace entries → phase separator rows: whichever end executed
    // (CLI/desktop), loading the session on the other end shows the record.
    // compaction.method distinguishes handoff from compact (old sessions have
    // no method, displayed as compact); title_change only counts user renames
    // (source "auto" is a new session's auto-generated title, not an
    // execution record)
    if (e.type === "compaction") {
      finalizeRun();
      const cmd = e.method === "handoff" ? "handoff" : "compact";
      out.push({ role: "phase", phase: "done", command: cmd, text: PHASE_TEXT[cmd][1] });
      continue;
    }
    if (e.type === "title_change") {
      if (e.source === "user") {
        finalizeRun();
        out.push({ role: "phase", phase: "done", command: "rename", text: PHASE_TEXT.rename[1] });
      }
      continue;
    }
    if (e.type !== "message") continue;
    const msg = e.message ?? {};
    const { role, content } = msg;
    const ts = Date.parse(e.timestamp ?? "") || 0;
    if (role === "toolResult") {
      if (run && ts) run.endMs = ts;
      const item = byId.get(msg.toolCallId);
      if (item) {
        let pendingWrite: { path: string; oldText?: string } | undefined;
        if (msg.toolName === "write") {
          const p = pathOf(item.args);
          if (p && !isDevicePath(p)) {
            const oldText = fileHistory.get(p);
            pendingWrite = { path: p, oldText };
            if (typeof item.args?.content === "string") {
              fileHistory.set(p, item.args.content);
            }
          }
        }
        Object.assign(item, summarizeResult(msg.toolName, item.args, msg, pendingWrite));
        if (msg.toolName === "read") {
          const p = pathOf(item.args);
          const readText = msg.details?.displayContent?.text;
          if (p && typeof readText === "string") {
            fileHistory.set(p, readText);
          }
        }
      }
      continue;
    }
    if (role === "bashExecution") {
      // ! local command result: flattened into a bash row; opens no new turn, joins no loop group
      out.push({
        role: "bash",
        text: msg.command,
        output: msg.output ?? "",
        exitCode: msg.exitCode ?? null,
        cancelled: !!msg.cancelled,
        truncated: !!msg.truncated,
        excludeFromContext: !!msg.excludeFromContext,
        running: false,
      });
      continue;
    }
    if (role === "fileMention") {
      // @ mention already read: flattened into a mention row
      out.push({ role: "mention", text: "", files: (msg.files ?? []).map((f: { path?: unknown }) => String(f.path ?? "")) });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    // Provider failure entries carry no content, only `errorMessage`. Surface them as
    // their own top-level row: a run may be collapsed into a loop group, its failure
    // must not be — otherwise a reloaded session loses the reason it stopped.
    if (role === "assistant") {
      const errText = errorTextOf(msg);
      if (errText) {
        finalizeRun();
        out.push({ role: "error", text: errText });
        continue;
      }
    }
    if (role === "user") {
      const text = stripDcpTags(typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"));
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "image") {
            const data = b.data || b.source?.data;
            const mimeType = b.mimeType || b.source?.media_type || b.source?.mimeType || "image/png";
            if (typeof data === "string") {
              images.push({ type: "image", data, mimeType });
            }
          }
        }
      }
      if (!isJunkPlaceholderText(text) || images.length > 0) {
        finalizeRun(); // Valid user input opens a new turn
        out.push({
          role: "user",
          text,
          entryId: e.id,
          ...(images.length > 0 ? { images } : {}),
        });
        run = { items: [], usage: null, startMs: ts, endMs: ts };
      }
      continue;
    }
    if (run) {
      run.endMs = ts || run.endMs;
      if (msg.usage) {
        run.usage = run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        run.usage.input += msg.usage.input || 0;
        run.usage.output += msg.usage.output || 0;
        run.usage.cacheRead += msg.usage.cacheRead || 0;
        run.usage.cacheWrite += msg.usage.cacheWrite || 0;
      }
    }
    const sink = run ? run.items : out; // Orphan assistants outside a run (no turn-leading user message) flatten directly, preserving old behavior
    if (typeof content === "string") {
      const plain = stripDcpTags(content);
      if (!isJunkPlaceholderText(plain)) {
        sink.push({ role, text: plain, entryId: e.id, endMs: ts });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") {
        const plain = stripDcpTags(block.text);
        if (!isJunkPlaceholderText(plain)) {
          sink.push({ role: "assistant", text: plain, entryId: e.id, endMs: ts });
        }
      } else if (block.type === "thinking" && block.thinking) {
        sink.push({
          role: "thinking",
          text: hostI18n.t("flows.think.with", { duration: hostI18n.t("flows.think.durationFew") }),
          thinking: String(block.thinking),
          expandable: true,
        });
      } else if (block.type === "toolCall") {
        // block.intent: the extracted `i` (persisted alongside the raw arguments, which still
        // carry `i`); toolArgsForUi filters args, so intent is the only surviving copy
        const item: TranscriptItem = {
          role: "tool",
          text: block.name,
          name: block.name,
          toolCallId: block.id,
          args: toolArgsForUi(block.name, block.arguments),
          files: collectFiles(block.name, block.arguments),
          intent: typeof block.intent === "string" ? block.intent : undefined,
        };
        byId.set(block.id, item);
        sink.push(item);
      }
    }
  }
  finalizeRun();
  return out;
}

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

// Whole-session active duration (ms): segments turns the same way
// entriesToTranscript does, summing each turn's "valid user input → turn
// end" wall-clock span (at least 1 second per turn, same scope as the loop
// group's durationSec). Used to seed the host's in-memory timer when loading
// a past session — it cannot come from summing the transcript's loop groups:
// pure-conversation turns (no tool calls) generate no loop group, so turns
// would be missed (measured: 2 turns produced only 1 loop).
export function sumRunDurationMs(entries: any[]): number {
  let total = 0;
  let startMs = 0;
  let endMs = 0;
  let open = false;
  const flush = () => {
    if (!open) return;
    total += Math.max(1000, endMs - startMs);
    open = false;
  };
  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = e.message ?? {};
    const { role, content } = msg;
    const ts = Date.parse(e.timestamp ?? "") || 0;
    if (role === "toolResult") {
      if (open && ts) endMs = ts;
      continue;
    }
    if (role === "user") {
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join("\n");
      if (isJunkPlaceholderText(text)) continue; // Hidden companion/placeholder messages open no turn
      flush();
      startMs = ts;
      endMs = ts;
      open = true;
      continue;
    }
    if (role === "assistant" && open) endMs = ts || endMs;
  }
  flush();
  return total;
}

// Subagent events → frontend narrow events (pure forwarding, not persisted into the parent session's transcript; text is accumulated by the frontend keyed on subagentId)
export function translateSubagentEvent(ev: any): UiEvent | null {
  switch (ev.type) {
    case "agent_start":
      return { kind: "turn_start" };
    case "message_update":
      if (ev.assistantMessageEvent?.type === "text_delta") {
        return { kind: "text_delta", text: ev.assistantMessageEvent.delta };
      }
      return null;
    case "tool_execution_start": {
      const args = toolArgsForUi(ev.toolName, ev.args);
      return { kind: "tool", name: ev.toolName, toolCallId: ev.toolCallId, args, files: collectFiles(ev.toolName, ev.args) };
    }
    case "tool_execution_end":
      return {
        kind: "tool_update",
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        ...summarizeResult(ev.toolName, ev.args, ev.result),
      };
    case "agent_end":
      if (ev.isTerminal === false) return null;
      return { kind: "turn_end" };
    default:
      return null;
  }
}
