// omp events → frontend narrow-event translate layer: the frontend only knows
// these UiEvent kinds and does not depend on omp event shape details.
// The live stream (translateEvent) and the disk history (entriesToTranscript)
// share the same tool-entry summary logic.
import fsp from "node:fs/promises";
import path from "node:path";
import { hostI18n } from "./i18n/host.ts";
import { collectFiles, isDevicePath, pathOf, summarizeResult, toolArgsForUi } from "./translate-tool.ts";
import type { TurnUsage, TranscriptItem, PoolEntry } from "./state.ts";

// Compat regex for journals written by the retired ACP nudge prototype: old
// sessions carry <dcp-message-id>mNNNNN</dcp-message-id> tags that UI
// rendering must still strip (kept verbatim from acp-context.ts).
const REF_TAG_RE = /<dcp-message-id>m\d{1,5}<\/dcp-message-id>\n?/g;

// In-flight write tool snapshot before mutation: caches the pre-write text to
// generate an accurate diff between the old and new file contents when the
// tool completes, avoiding whole-file fallbacks; `owner` scopes agent_end cleanup to the parking session.
// Exported for the diff tests: they spin the event loop until a pending snapshot lands
// before overwriting the fixture file (the pre-read is async, see preadWriteOldText).
export const pendingWrites = new Map<string, { path: string; oldText?: string; owner?: PoolEntry }>();

// 3c: async pre-read of the file a `write` tool is about to overwrite (the sync
// version ran on every socket fan-out's critical path). Placeholder set synchronously,
// filled only while the toolCallId is still pending — if tool_execution_end wins the
// race, the whole-file fallback diff is honest. Residual race: a read scheduled after
// a very fast write presents post-write text as oldText (empty diff — no data loss).
async function preadWriteOldText(toolCallId: string, abs: string, owner: PoolEntry): Promise<void> {
  let oldText: string | undefined;
  try {
    const st = await fsp.stat(abs);
    if (st.isFile() && st.size <= 2_000_000) oldText = await fsp.readFile(abs, "utf8");
  } catch {
    return; // missing/unreadable: keep the placeholder (no oldText)
  }
  if (oldText === undefined) return;
  const pending = pendingWrites.get(toolCallId);
  if (pending && pending.owner === owner && pending.oldText === undefined) pending.oldText = oldText;
}


// Strip the <dcp-message-id> tags injected/replayed by ACP: disk keeps the
// original text (historical fact); scrub uniformly before pushing to the UI.
// Brief flashes during live text_delta streaming are handled by the frontend
// render layer (AssistantMsg).
export function stripDcpTags(s: string): string {
	const out = s.replace(REF_TAG_RE, "");
	return out === s ? s : out.trim();
}

// UiEvent moved to the wire contract (wire/payloads.ts, A10); re-exported for
// host consumers. The hand-rolled union here had drifted from what senders
// emit (missing the user_message variant that automations/scheduler.ts sends).
import type { UiEvent } from "./wire/payloads.ts";
export type { UiEvent };

function thinkingLabel(sec: number): string {
  if (sec < 5) return hostI18n.t("flows.think.durationFew");
  if (sec < 60) return hostI18n.t("flows.think.durationSec", { n: sec });
  return hostI18n.t("flows.think.durationMinSec", { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, "0") });
}

function isJunkPlaceholderText(text?: string | null): boolean {
  if (!text) return true;
  const t = text.trim();
  return t === "." || t === "。" || t === "·" || t === "•";
}

// user message content (string or blocks) → plain text, same extraction scope as the base's branch()
function userEntryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object" || !("type" in b) || b.type !== "text" || !("text" in b) || typeof b.text !== "string") continue;
    texts.push(b.text);
  }
  return texts.join("\n");
}

// At agent_end this round's user messages are necessarily persisted: align
// and backfill the transcript's user entries lacking entryId against the
// user messages in the disk entries by text (the base's event stream carries
// no entry id, so alignment can only happen after the fact; hidden
// companion/system-injected messages have different text, so equality
// matching naturally skips them). Within one call the from pointer preserves
// order, so duplicate texts still line up; across calls, disk entries already
// consumed by an earlier round are excluded by id — otherwise two identical
// texts (e.g. two "go on" nudges) would re-match the first disk entry forever
// and the returned anchor would point at the previous round's message. Returns the
// last entryId backfilled this round (for the turn_end event's incremental
// delivery), or undefined when there was nothing to backfill.
export function backfillUserEntryIds(entry: PoolEntry): string | undefined {
  const all = entry.transcript;
  const pending = all.filter((t) => t.role === "user" && !t.entryId);
  if (pending.length === 0) return undefined;
  const used = new Set(all.filter((t) => t.role === "user" && t.entryId).map((t) => t.entryId));
  const users = (entry.manager?.getEntries() ?? [])
    .filter((e: any) => e?.type === "message" && e.message?.role === "user" && !used.has(e.id as string))
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
  // Candidates must mirror transcript production 1:1 — one slot per non-junk
  // TEXT BLOCK, not per disk entry: thinking/toolCall-only messages and
  // aborted empty replies produce no assistant transcript item, so positional
  // entry-level alignment shifts left and the fork button under a turn's
  // final output ends up anchoring an earlier assistant message (the slice
  // then drops the output the user forked from).
  const cands: string[] = [];
  for (const e of raw.slice(dFrom)) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    if (isErrorOnlyMessage(e.message)) continue;
    const push = (s: string) => {
      if (!isJunkPlaceholderText(stripDcpTags(s))) cands.push(e.id);
    };
    const content = e.message.content;
    if (typeof content === "string") {
      push(content);
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text" && typeof block.text === "string") push(block.text);
    }
  }
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
          // Sync placeholder, async fill (see preadWriteOldText) — tool_execution_end never stalls on it
          pendingWrites.set(ev.toolCallId, { path: abs, owner: entry });
          void preadWriteOldText(ev.toolCallId, abs, entry);
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
      // 3c: an interrupted turn can strand a pre-read snapshot (≤2MB) — sweep this session's at terminal end
      for (const [k, v] of pendingWrites) if (v.owner === entry) pendingWrites.delete(k);
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
