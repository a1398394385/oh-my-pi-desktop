// omp 事件 → 前端窄事件翻译层：前端只认 UiEvent 这些 kind，不依赖 omp 事件 shape 细节。
// 实时流（translateEvent）与磁盘历史（entriesToTranscript）共用同一套工具条目摘要逻辑。
import type { TurnUsage, TranscriptItem, PoolEntry } from "./state.ts";

export type UiEvent =
  | { kind: "turn_start" }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking"; phase: "start" | "end"; durationLabel?: string; thinking?: string; expandable?: boolean }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool"; name: string; toolCallId?: string; args?: Record<string, unknown>; files?: string[]; intent?: string }
  | { kind: "tool_update"; name: string; toolCallId?: string; files?: string[]; added?: number; removed?: number; todo?: TranscriptItem["todo"]; output?: string; details?: unknown; diffContent?: string }
  | { kind: "turn_end"; usage?: TurnUsage | null; userEntryId?: string; runEnd?: boolean }
  | { kind: "thinking_level"; configured?: string; resolved?: string }
  | { kind: "mention"; files: string[] }; // @ 提及回读（attachEntry 的 agent_end 扫描直发，不经 translateEvent）

// 工具设备路径（xd://tui、xd://mcp__xxx 等）：读/写它是调用设备，不是文件读写
function isDevicePath(p: unknown): boolean {
  return typeof p === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
}

function pathOf(args: any): string {
  if (!args || typeof args !== "object") return "";
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return "";
}

function collectFiles(name: string, args: any, details?: any): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p !== "string" || !p) return;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm; // 相对路径与绝对路径视为同一文件，保留更完整的
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
  if (Array.isArray(details?.perFileResults)) for (const f of details.perFileResults) push(f?.path);
  if (typeof details?.path === "string") push(details.path);
  if (typeof details?.resolvedPath === "string") push(details.resolvedPath);
  const p = pathOf(args);
  if (p) push(p);
  return out;
}

function toolArgsForUi(name: string, args: any): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  if (name === "bash" || name === "shell") return { command: String(args.command ?? "").slice(0, 4000) };
  if (name === "eval") return { command: String(args.code ?? args.command ?? "").slice(0, 4000) }; // JS 求值，走终端卡片渲染
  if (name === "grep") return { pattern: String(args.pattern ?? args.query ?? "").slice(0, 500), path: pathOf(args) };
  if (name === "glob") return { pattern: String(args.pattern ?? "").slice(0, 500), path: pathOf(args) };
  if (name === "web_search") return { query: String(args.query ?? "").slice(0, 1000) };
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
  const path = pathOf(args);
  const out: Record<string, unknown> = {};
  if (path) out.path = path;
  if (files.length) out.files = files;
  if (typeof args.content === "string") out.content = args.content.slice(0, 8000);
  return out;
}

// 结构化参数（ask.questions / retain.memories 等）超限降级为截断 JSON 字符串，保护 WebSocket 帧
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
  if (sec < 5) return "持续了几秒";
  if (sec < 60) return `持续了 ${sec} 秒`;
  return `持续了 ${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

// 工具结果文本：拼接 result.content 里的 text 段（截断，详细走 artifact）
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

function summarizeResult(name: string, args: any, result: any): Partial<TranscriptItem> {
  const details = result?.details ?? (result && typeof result === "object" && "diff" in result ? result : undefined);
  const patch: Partial<TranscriptItem> = {};
  const files = collectFiles(name, args, details);
  if (files.length) patch.files = files;
  if (name === "read") {
    // 透传 TUI 同款渲染数据：displayContent 是模型所见的原文（无行号前缀），行号范围来自 truncation.shownRange
    const dc = details?.displayContent;
    if (dc && typeof dc.text === "string" && dc.text) {
      const MAX = 200_000; // WebSocket 传输与前端渲染的现实边界，正常 read（自带截断）远达不到
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
      };
    }
    // 目录读取兜底：无 displayContent 时也要带 isDirectory（前端据此过滤出查阅组）
    else if (details?.isDirectory) patch.details = { isDirectory: true };
  }
  if (name === "bash" || name === "shell" || name === "eval") {
    // 终端/求值工具：把输出文本带给前端展开卡片（截断，详细走 artifact）
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
  // 标签型工具（联网搜索/提问/调试/GitHub/LSP/记忆五件套）：结果文本供给前端展开卡
  if (
    name === "web_search" || name === "ask" || name === "debug" || name === "github" || name === "lsp" ||
    name === "retain" || name === "recall" || name === "reflect" || name === "learn" || name === "memory_edit"
  ) {
    const text = resultText(result);
    if (text) patch.output = text;
    return patch;
  }
  if (Array.isArray(details?.perFileResults) && details.perFileResults.length > 1) {
    return patch; // 多文件「更改」不带行数
  }
  if (typeof details?.diff === "string") {
    Object.assign(patch, diffStats(details.diff));
    // 把当次工具的真实修改一并带给前端：编辑行内联展开直接渲染它（新文件/无 git 基线时
    // git diff 只能给全量新增，与 +N-M 摘要对不上）；截断上限与 file_diff 回包一致口径
    patch.diffContent = details.diff.slice(0, 500_000);
  }
  else if ((name === "write" || name === "edit") && typeof args?.content === "string") {
    // 写入工具设备（xd://tui 等）不是文件编辑：既没有文件 diff 可看，按 content 行数算的
    // 增删也是假的——改为下发设备回包文本，供设备行展开查看
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

// user message content（string 或 blocks）→ 纯文本，与底座 branch() 的提取口径一致
function userEntryText(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
}

// agent_end 时本轮用户消息必然已落盘：把 transcript 中缺 entryId 的 user 条目与磁盘
// entries 里的 user message 按文本对齐回填（底座事件流不携带 entry id，只能事后对齐；
// 隐藏伴随/系统注入消息文本不同，按相等匹配天然跳过；from 指针保序，重复文本也对得上）。
// 返回本轮补上的最后一个 entryId（供 turn_end 事件增量下发），无可补则 undefined。
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
    if (hit < 0) continue; // 尚未落盘（排队中）等下轮 turn_end 再补
    item.entryId = users[hit].id;
    from = hit + 1;
    last = item.entryId;
  }
  return last;
}

function flushAssistantDraft(entry: PoolEntry) {
  if (!entry.assistantDraft) return;
  if (!isJunkPlaceholderText(entry.assistantDraft)) {
    entry.transcript.push({ role: "assistant", text: entry.assistantDraft });
  }
  entry.assistantDraft = "";
}

function uiToolPayload(item: TranscriptItem): Extract<UiEvent, { kind: "tool" }> {
  return { kind: "tool", name: item.name ?? item.text, toolCallId: item.toolCallId, args: item.args, files: item.files };
}

// 累加本 run 全部 assistant 消息的 token 用量（agent_end.messages 只含本次 run 新增，不含载入的历史）
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
      // run 内每个模型轮的真实起点（排队消息消费的续轮同样经过这里）：
      // 轮边界是服务端权威投影（ZCode turnHeader 同款语义），UI 不得靠
      // agent_start/agent_end 的 run 级近似重猜——那是排队消费续轮对 UI 隐形的根因
      return { kind: "turn_start" };
    case "turn_end": {
      // run 内每个模型轮的真实结束：封存本轮过程。usage 只取本轮 assistant 消息；
      // 整 run 用量、userEntryId 回填、列表刷新由 agent_end 映射的 runEnd 帧负责
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
      // auto 判定帧：configured==="auto" 时 resolved 为本轮判定档位（切进 auto 的 provisional 帧无 resolved）；
      // 人工切档帧无 configured。只透传，前端自行决定显示。
      return { kind: "thinking_level", configured: ev.configured, resolved: ev.resolved };
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
        entry.transcript.push({ role: "thinking", text: "思考" });
        return { kind: "thinking", phase: "start" };
      }
      if (ame?.type === "thinking_delta") {
        entry.thinkingDraft += ame.delta ?? "";
        // hideThinkingBlock 只影响 UI 默认展开与否，不影响数据下发：增量照常转发供流式展示
        return { kind: "thinking_delta", text: ame.delta ?? "" };
      }
      if (ame?.type === "thinking_end") {
        const last = [...entry.transcript].reverse().find((t) => t.role === "thinking");
        const thinking = (ame.content || entry.thinkingDraft || "").trim();
        const sec = entry.thinkingStartedAt ? Math.max(1, Math.round((Date.now() - entry.thinkingStartedAt) / 1000)) : 0;
        const durationLabel = thinkingLabel(sec);
        if (last) {
          last.text = `思考 · ${durationLabel}`;
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
      const args = toolArgsForUi(ev.toolName, ev.args);
      const item: TranscriptItem = {
        role: "tool",
        text: ev.toolName,
        name: ev.toolName,
        toolCallId: ev.toolCallId,
        args,
        files: collectFiles(ev.toolName, ev.args),
      };
      entry.transcript.push(item);
      // intent：模型在工具参数里写的 i 字段（agent-loop 已提取成字符串），working 状态行直接显示
      return { ...uiToolPayload(item), intent: typeof ev.intent === "string" && ev.intent.trim() ? ev.intent.trim() : undefined };
    }
    case "tool_execution_end": {
      const item =
        entry.transcript.findLast?.((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.toolCallId === ev.toolCallId) ??
        [...entry.transcript].reverse().find((t) => t.role === "tool" && t.name === ev.toolName);
      if (item) Object.assign(item, summarizeResult(ev.toolName, { ...(item.args || {}), ...(ev.args || {}) }, ev.result));
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
        diffContent: item?.diffContent, // 编辑行内联展开优先用当次回包的真实 diff
      };
    }
    case "agent_end":
      // isTerminal === false 表示 maintenance/异步投递还会续跑，不是真正结束
      if (ev.isTerminal === false) return null;
      flushAssistantDraft(entry);
      return { kind: "turn_end", runEnd: true, usage: sumRunUsage(ev.messages), userEntryId: backfillUserEntryIds(entry) };
    default:
      return null;
  }
}

// 磁盘历史条目 → 前端 transcript（思考块可展开；工具带路径/命令/行数）
// 轮次分组：一条用户消息开启一轮，轮内 thinking/tool/中间 assistant 收进 loop 组（收起显示），
// 只把最后一条 assistant 文本留在组外作为该轮的对外结果——与实时 turn_end 的收起行为一致。
export function entriesToTranscript(entries: any[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
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
    if (e.type !== "message") continue;
    const msg = e.message ?? {};
    const { role, content } = msg;
    const ts = Date.parse(e.timestamp ?? "") || 0;
    if (role === "toolResult") {
      if (run && ts) run.endMs = ts;
      const item = byId.get(msg.toolCallId);
      if (item) Object.assign(item, summarizeResult(msg.toolName, item.args, msg));
      continue;
    }
    if (role === "bashExecution") {
      // ! 本地命令结果：平铺成 bash 行，不开启新轮次、不进 loop 组
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
      // @ 提及已读取：平铺成 mention 行
      out.push({ role: "mention", text: "", files: (msg.files ?? []).map((f: { path?: unknown }) => String(f.path ?? "")) });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user") {
      const text = typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      if (!isJunkPlaceholderText(text)) {
        finalizeRun(); // 有效用户输入开启新一轮
        out.push({ role: "user", text, entryId: e.id });
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
    const sink = run ? run.items : out; // run 外的孤儿 assistant（无轮首用户消息）直接平铺，保持旧行为
    if (typeof content === "string") {
      if (!isJunkPlaceholderText(content)) {
        sink.push({ role, text: content });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text") {
        if (!isJunkPlaceholderText(block.text)) {
          sink.push({ role: "assistant", text: block.text });
        }
      } else if (block.type === "thinking" && block.thinking) {
        sink.push({
          role: "thinking",
          text: "思考 · 持续了几秒",
          thinking: String(block.thinking),
          expandable: true,
        });
      } else if (block.type === "toolCall") {
        const item: TranscriptItem = {
          role: "tool",
          text: block.name,
          name: block.name,
          toolCallId: block.id,
          args: toolArgsForUi(block.name, block.arguments),
          files: collectFiles(block.name, block.arguments),
        };
        byId.set(block.id, item);
        sink.push(item);
      }
    }
  }
  finalizeRun();
  return out;
}

// 子代理事件 → 前端窄事件（纯转发，不落父会话 transcript；文本由前端按 subagentId 累积）
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
