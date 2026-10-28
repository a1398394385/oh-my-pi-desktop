// Disk history → frontend transcript. Split out of translate.ts: the live event
// translator and the on-disk replay share only the small helpers in translate-tool.ts and
// a few exports from translate.ts, and keeping them together kept tripping the line cap.
import { hostI18n } from "./i18n/host.ts";
import { collectFiles, isDevicePath, pathOf, summarizeResult, toolArgsForUi } from "./translate-tool.ts";
import type { TranscriptItem, TurnUsage } from "./wire/payloads.ts";
import { PHASE_TEXT, isJunkPlaceholderText, errorTextOf, stripDcpTags } from "./translate.ts";
import { BRANCH_TITLE_CUSTOM_TYPE } from "./session-titles.ts";
import { deliveryMarkerOf, deliveryMarkersForSession, type DeliveryMarker } from "./automations/delivery.ts";
import { advisorHistoryRow } from "./translate-advisor.ts";

// Disk history entries → frontend transcript (thinking blocks expandable;
// tools carry path/command/line counts)
// Turn grouping: one user message opens a turn; the turn's thinking/tool/
// intermediate assistant items are collected into a loop group (displayed
// collapsed), leaving only the last assistant text outside the group as the
// turn's outward result — matching the live turn_end collapse behavior.
// The approved-plan execution turn persists as a synthetic developer message
// (the base marks plan-approved prompts synthetic to skip user attribution).
// The live dispatch echoes the plan as a user bubble (host/plan-approve.ts);
// rebuilds from disk must map the same entry back so the turn groups like an
// operator turn. Marker: the rendered prompt wraps the plan body in
// <plan path="...">...</plan> (base template plan-mode-approved.md); other
// synthetic developer messages (auto-continue, reminders) carry no plan block
// and keep their existing handling.
function approvedPlanBody(content: unknown): string | undefined {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((b): string[] => {
        if (typeof b !== "object" || b === null || !("type" in b) || !("text" in b)) return [];
        return b.type === "text" && typeof b.text === "string" ? [b.text] : [];
      })
      .join("\n");
  }
  const open = text.indexOf("<plan");
  const close = text.lastIndexOf("</plan>");
  if (open < 0 || close <= open) return undefined;
  const nl = text.indexOf("\n", open);
  if (nl < 0 || nl >= close) return undefined;
  // The template adds one newline before </plan>; the live echo sends planContent
  // verbatim, so strip it to keep both paths byte-identical.
  return text.slice(nl + 1, close).replace(/\n$/, "");
}

// sessionPath: replay falls back to the automations runs ledger for deliveries written
// before the durable marker existed (deliveryMarkersForSession). Omitted = no fallback.
export function entriesToTranscript(entries: any[], sessionPath?: string): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  const fileHistory = new Map<string, string>();
  let run: { items: TranscriptItem[]; usage: TurnUsage | null; startMs: number; endMs: number } | null = null;

  const finalizeRun = () => {
    if (!run) return;
    const r = run;
    run = null;
    // Outward result = every turn-final assistant text (stopReason "stop": a delivered
    // output, even when a mid-run wake — advisor note, async result, steer — kept the run
    // going afterwards), plus the trailing assistant as the pre-mark fallback (covers
    // error/aborted tails and legacy sessions). Advice rows (a note about the output
    // before them) and error rows (folded like any other event) sit after that output,
    // so skip both when scanning for the tail. Order is stream order: one pass keeps it.
    let lastA = r.items.length - 1;
    while (lastA >= 0 && (r.items[lastA].role === "advisor" || r.items[lastA].role === "error")) lastA--;
    const tailIdx = r.items[lastA]?.role === "assistant" ? lastA : -1;
    const kept: TranscriptItem[] = [];
    const finalOut: TranscriptItem[] = [];
    r.items.forEach((it, i) => {
      (it.role === "assistant" && (it.turnFinal || i === tailIdx) ? finalOut : kept).push(it);
    });
    if (kept.length) {
      out.push({
        role: "loop",
        text: "",
        collapsed: true,
        items: kept,
        durationSec: Math.max(1, Math.round((r.endMs - r.startMs) / 1000)),
        usage: r.usage,
      });
    }
    out.push(...finalOut);
  };

  // Branch titles own the rename record once a session carries any: the base's
  // title_change is header-global, and with branch titles on, every settled turn
  // writes one with source "user" (the header unlock) that must never render.
  // Sessions without branch titles keep the original title_change rendering.
  const hasBranchTitles = entries.some((e) => e.type === "custom" && e.customType === BRANCH_TITLE_CUSTOM_TYPE);

  // Scheduler delivery waiting for the user message it introduces (the scheduler writes
  // the custom entry, then the base writes the prompt entry). Markers predating that
  // record fall back to the runs ledger, matched on the exact prompt text.
  let pendingDelivery: DeliveryMarker | null = null;
  const ledgerMarkers = sessionPath ? deliveryMarkersForSession(sessionPath) : null;

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
      if (!hasBranchTitles && e.source === "user") {
        finalizeRun();
        out.push({ role: "phase", phase: "done", command: "rename", text: PHASE_TEXT.rename[1] });
      }
      continue;
    }
    if (e.type === "custom" && e.customType === BRANCH_TITLE_CUSTOM_TYPE) {
      // Header metadata (sidebar + window title only). Rendering it would print a
      // rename row on every settled turn, because each refresh writes one with
      // source "user" to unlock the header.
      continue;
    }
    if (e.type === "custom") {
      const marker = deliveryMarkerOf(e);
      if (marker) {
        pendingDelivery = marker;
        continue;
      }
    }
    if (e.type !== "message") {
      if (e.type === "ttsr_injection") {
        // Historical replay: the disk entry keeps only the injected names (rule bodies are
        // never persisted), so the row carries no descriptions
        const rules = (Array.isArray(e.injectedRules) ? (e.injectedRules as unknown[]) : [])
          .filter((n): n is string => typeof n === "string" && n.length > 0)
          .map((name) => ({ name }));
        if (rules.length > 0) {
          const item: TranscriptItem = { role: "ttsr", text: rules.map((r) => r.name).join(", "), rules };
          if (run) run.items.push(item);
          else out.push(item);
        }
        continue;
      }
      // An advice row is one more event inside the same run: the reader sees a single
      // collapsed "process" group per turn, not a run cut in half by a note. The renderer
      // lifts it out of the group when it would otherwise hide (LoopGroup collapsed).
      const advice = advisorHistoryRow(e);
      if (advice) {
        if (run) run.items.push(advice);
        else out.push(advice);
      }
      continue;
    }
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
    // The approved-plan execution turn: map the synthetic developer message
    // back to the user bubble the live dispatch echoed (approvedPlanBody);
    // the execution turn groups like an operator turn. Other synthetic
    // developer messages fall through to the default handling below. Sits
    // before the role guard (developer is not user/assistant).
    if (role === "developer" && msg.synthetic === true) {
      const plan = approvedPlanBody(content);
      if (plan !== undefined) {
        finalizeRun(); // The approved plan opens the execution turn, same as a user prompt
        out.push({ role: "user", text: stripDcpTags(plan), entryId: e.id });
        run = { items: [], usage: null, startMs: ts, endMs: ts };
        continue;
      }
    }
    if (role !== "user" && role !== "assistant") continue;
    // Provider failure entries carry no content, only `errorMessage`. They join the run like
    // any other event and fold away with it (one "process" group per turn); closing the run
    // here instead split one turn into "group + error + flat rows" whenever the journal held
    // later entries of the same run (attempt 1 fails, attempt 2 continues), which no live
    // turn ever shows. No open run (failure before the turn had an event) → top-level row.
    if (role === "assistant") {
      const errText = errorTextOf(msg);
      if (errText) {
        if (run) {
          run.endMs = ts || run.endMs;
          run.items.push({ role: "error", text: errText });
        } else out.push({ role: "error", text: errText });
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
        const marker = pendingDelivery ?? ledgerMarkers?.get(text.trim()) ?? null;
        out.push({
          role: "user",
          text,
          entryId: e.id,
          ...(images.length > 0 ? { images } : {}),
          ...(marker ? { automation: marker } : {}),
        });
        run = { items: [], usage: null, startMs: ts, endMs: ts };
      }
      pendingDelivery = null;
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
        sink.push({ role, text: plain, entryId: e.id, endMs: ts, ...(role === "assistant" && msg.stopReason === "stop" ? { turnFinal: true } : {}) });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") {
        const plain = stripDcpTags(block.text);
        if (!isJunkPlaceholderText(plain)) {
          sink.push({ role: "assistant", text: plain, entryId: e.id, endMs: ts, ...(msg.stopReason === "stop" ? { turnFinal: true } : {}) });
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
    if (role === "developer" && msg.synthetic === true && approvedPlanBody(content) !== undefined) {
      // Same turn segmentation as entriesToTranscript: the approved plan opens the execution turn
      flush();
      startMs = ts;
      endMs = ts;
      open = true;
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

