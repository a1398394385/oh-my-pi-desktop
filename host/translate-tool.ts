// Tool-entry summary projection shared by the live stream (translateEvent)
// and the disk history (entriesToTranscript): path extraction, per-tool arg
// whitelisting for the UI, and tool result summarization (diff stats,
// output text, per-tool details). Split out of translate.ts (row-limit).
import { editDiffString } from "@oh-my-pi/pi-natives";
import type { TranscriptItem } from "./state.ts";

// Tool device paths (xd://tui, xd://mcp__xxx, ...): reading/writing one invokes a device, not a file read/write
export function isDevicePath(p: unknown): boolean {
  return typeof p === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
}

export function pathOf(args: any): string {
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

export function collectFiles(name: string, args: any, details?: any): string[] {
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

export function toolArgsForUi(name: string, args: any): Record<string, unknown> {
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
  if (name === "yield") {
    // Subagent result submission: the payload IS the row's subject (the frontend derives
    // its one-line summary from these), so carry all four fields through instead of letting
    // them fall into the generic path/content filter. `data` can be an arbitrary output
    // object, so it goes through the frame cap like the other structured params.
    return {
      type: Array.isArray(args.type) ? args.type.slice(0, 20).map(String) : args.type,
      key: args.key,
      data: capValue(args.data),
      error: typeof args.error === "string" ? args.error.slice(0, 2000) : args.error,
    };
  }
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

export function summarizeResult(name: string, args: any, result: any, pendingWrite?: { path: string; oldText?: string }): Partial<TranscriptItem> {
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
  // Tagged tools (find / web search / ask / debug / GitHub / LSP / yield / the memory suite): result text feeds the frontend's expandable card
  if (
    name === "find" ||
    name === "web_search" || name === "ask" || name === "debug" || name === "github" || name === "lsp" ||
    name === "read_session_context" || name === "yield" ||
    name === "retain" || name === "recall" || name === "reflect" || name === "learn" || name === "memory_edit" ||
    name === "context_status" || name === "compress_context"
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
