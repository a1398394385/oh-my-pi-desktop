// 消息发送域 RPC：prompt（附件组装/slash 分发/排队修剪）、排队队列操作、本地 bash、
// 输入框 sigil 候选（斜杠命令清单 / @ 文件匹配）。自 main.ts message 分发平移（第三刀）。
import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type {
  AvailableCommandsSession,
  InternalAvailableSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import {
  buildAvailableSlashCommands,
  parseSlashCommand,
  parseSkillInvocation,
  buildSkillPromptMessage,
  SKILL_PROMPT_MESSAGE_TYPE,
  executeAcpBuiltinSlashCommand,
  fuzzyFind,
} from "../bootstrap.ts";
import { sessions, defaultCwd, stampEvent, type PoolEntry, type TranscriptItem } from "../state.ts";
import { entriesToTranscript, PHASE_TEXT } from "../translate.ts";
import { pushContext } from "../session-lifecycle.ts";
import { handlePlanCommand } from "../plan.ts";
import { sendQueued, parkFollowUpTail, handlePeekQueued, handleDropQueued, handleSendNow, handleRequeue } from "../queue.ts";
import { handleListSessions } from "./session";
import type { RpcHandler } from "./types";

// 前端随 prompt 下发的附件：图片为 base64，文本类为文件内容
interface PromptAttachment {
  kind: "image" | "text";
  mime?: string;
  data?: string; // image：base64（无 data: 前缀）
  name?: string; // text：文件名
  text?: string; // text：文件内容
}

// ---------- 输入框 sigil：命令清单与 @ 文件候选 ----------

// 桌面端不通过 sigil 提供的斜杠命令：模型/思考级别/会话开关这几类，能力分别由输入框胶囊
// （模型/思考/ModeMenu）与设置页承担，清单过滤与执行拦截共用本表（值为命中提示）。
// key 含别名（/models 是 /model 的别名；/force:xxx 经 parseSlashCommand 归到 force）。
const REMOVED_SLASH_COMMANDS: Record<string, string> = {
  model: "模型切换请用输入框的模型胶囊",
  models: "模型切换请用输入框的模型胶囊",
  switch: "模型切换请用输入框的模型胶囊",
  prewalk: "模型交接已移除",
  fast: "服务档（fast）切换已移除",
  skillful: "技能清单开关请到设置页操作",
  "extended-context": "扩展上下文开关请到设置页操作",
  computer: "电脑控制开关请到设置页操作",
  force: "强制工具选择已移除",
  fork: "会话分叉请点击回复下方的分叉按钮",
};

/** 已移除命令的提示文案；非已移除命令返回 null */
function removedSlashHint(text: string): string | null {
  const parsed = parseSlashCommand(text.trim());
  if (!parsed) return null;
  const hint = REMOVED_SLASH_COMMANDS[parsed.name];
  return hint ? `/${parsed.name} 已移除：${hint}` : null;
}

// 新建会话页隐藏的会话级命令：操作/统计「已存在的会话」，首条消息发出前无意义
// （压缩/交接/重试/会话管理/导出/统计等）。goal、memory、工具与插件管理、skill:* 等保留。
const NEW_SESSION_HIDDEN_SLASH_COMMANDS: Record<string, true> = {
  compact: true,
  handoff: true,
  shake: true,
  retry: true,
  fresh: true,
  rename: true,
  move: true,
  wt: true,
  "add-dir": true,
  "remove-dir": true,
  dirs: true,
  session: true,
  pin: true,
  jobs: true,
  usage: true,
  stats: true,
  context: true,
  trace: true,
  dump: true,
  share: true,
  export: true,
  todo: true,
};

// /goal：底座条目是 TUI-only（无 handle 不进清单），注入桌面实现的同名条目（执行走 dispatchSlashInput）
const GOAL_SLASH_COMMAND = {
  name: "goal",
  description: "Toggle goal mode (persistent autonomous objective for this session)",
  input: { hint: "[objective]" },
  source: "builtin" as const,
  subcommands: [
    { name: "set", description: "Set or replace the goal" },
    { name: "pause", description: "Pause the current goal" },
    { name: "resume", description: "Resume a paused goal" },
    { name: "drop", description: "Drop the current goal" },
    { name: "budget", description: "Adjust the token budget" },
  ],
};

// /plan：底座同样只有 handleTui（buildAvailableSlashCommands 的 `if (!command.handle) continue`
// 把它挡在清单外，手输还会被当普通 prompt 发给模型），注入桌面实现的同名条目。
const PLAN_SLASH_COMMAND = {
  name: "plan",
  description: "Toggle plan mode (agent plans before executing)",
  input: { hint: "[prompt]" },
  source: "builtin" as const,
};

// 命令清单帧：内置 + skill + 扩展 + 自定义 + 文件命令，可无 TUI 执行的那批
// （executeAcpBuiltinSlashCommand 的姊妹面）。映射成前端 PaletteMenu 直接消费的形状。
function sendCommandsFrame(
  ws: { send(data: string): unknown },
  sessionId: string | null,
  list: InternalAvailableSlashCommand[],
  hideSessionCommands: boolean,
) {
  const commands = list
    .filter((c) => !REMOVED_SLASH_COMMANDS[c.name] && (!hideSessionCommands || !NEW_SESSION_HIDDEN_SLASH_COMMANDS[c.name]))
    .concat(GOAL_SLASH_COMMAND, PLAN_SLASH_COMMAND);
  ws.send(
    JSON.stringify({
      type: "commands",
      sessionId,
      commands: commands.map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        description: c.description ?? "",
        hint: c.input?.hint ?? null,
        source: c.source,
        subcommands: (c.subcommands ?? []).map((s) => ({ name: s.name, description: s.description ?? "" })),
      })),
    }),
  );
}

async function pushCommands(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  sendCommandsFrame(ws, sessionId, await buildAvailableSlashCommands(entry.session), false);
}

// 新建会话页的命令清单（无会话条目）：skills/自定义命令借用池内任一会话（同一套配置加载，
// 各会话一致）；文件命令按新建项目 cwd 扫描；隐藏会话级命令。池内无会话时 skills 回退空。
async function pushNewSessionCommands(ws: { send(data: string): unknown }, cwd: string) {
  const any = sessions.values().next().value as PoolEntry | undefined;
  const stub = {
    customCommands: any?.session.customCommands ?? [],
    skills: any?.session.skills ?? [],
    skillsSettings: any?.session.skillsSettings ?? { enableSkillCommands: true },
    setSlashCommands: () => {},
    sessionManager: { getCwd: () => cwd },
  } as unknown as AvailableCommandsSession;
  sendCommandsFrame(ws, null, await buildAvailableSlashCommands(stub), true);
}

// @ 候选：绝对路径/家目录前缀走 readdir 前缀列举（对齐 TUI autocomplete 的目录补全），
// 其余走 fuzzyFind 全仓模糊搜索；任何错误静默返回空（弹层显示无匹配）
async function listFileMatches(root: string, query: string): Promise<Array<{ path: string; dir: boolean }>> {
  if (query.startsWith("/") || query.startsWith("~")) {
    try {
      const expanded = query.startsWith("~") ? os.homedir() + query.slice(1) : query;
      const searchDir = query.endsWith("/") ? expanded : path.dirname(expanded);
      const base = query.endsWith("/") ? "" : path.basename(expanded);
      const dirents = await readdir(searchDir, { withFileTypes: true });
      const prefix = base.toLowerCase();
      const dirPart = query.endsWith("/") ? query : query.slice(0, query.length - path.basename(query).length);
      return dirents
        .filter((d) => d.name !== ".git" && d.name.toLowerCase().startsWith(prefix))
        .map((d) => ({ path: dirPart + d.name, dir: d.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))
        .slice(0, 100);
    } catch {
      return [];
    }
  }
  try {
    const r = await fuzzyFind({ query, path: root, maxResults: 100, hidden: true, gitignore: true, cache: true });
    return r.matches.map((m) => ({ path: m.path, dir: m.isDirectory }));
  } catch {
    return [];
  }
}

// ---------- 斜杠命令本地分发 ----------
// 顺序对齐 ACP #runPromptOrCommand：/skill: → builtin（executeAcpBuiltinSlashCommand）→ 原样走 prompt。
// 返回 null = 本地消费（不调 prompt、不推 user transcript）；返回 string = 转成该文本继续走 prompt。
// prompt() 自身还会展开文件命令 / 自定义 TS 命令 / 扩展命令（agentInvoked=false 信号在 then 里处理）。
async function dispatchSlashInput(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  text: string,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return text;

  // 1) /skill:<name>：底座 prompt() 不处理，必须宿主分发（对齐 ACP #tryRunSkillCommand）
  const parsed = parseSkillInvocation(trimmed);
  const skill = parsed && entry.session.skillsSettings?.enableSkillCommands
    ? entry.session.skills.find((c) => c.name === parsed.name)
    : undefined;
  if (parsed && skill) {
    const built = await buildSkillPromptMessage(skill, parsed, "user");
    await entry.session.promptCustomMessage(
      {
        customType: SKILL_PROMPT_MESSAGE_TYPE,
        content: built.message,
        display: true,
        details: built.details,
        attribution: "user",
      },
      { streamingBehavior: "steer" },
    );
    return null;
  }

  // 2) 已移除命令：既不执行也不落成 prompt（清单已在 pushCommands 过滤，这里挡手输）
  const removedHint = removedSlashHint(trimmed);
  if (removedHint) {
    ws.send(JSON.stringify({ type: "command_output", sessionId, text: removedHint }));
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }

  // 2.5) /goal、/plan：桌面实现（底座两者都只有 handleTui，executeAcpBuiltinSlashCommand 不接手）。
  // 返回文本转正常 prompt 链路（transcript/排队复用）；null = 已消费
  const parsedSlash = parseSlashCommand(trimmed);
  if (parsedSlash?.name === "goal") {
    const objective = await entry.goal.handleCommand(parsedSlash.args);
    if (objective !== null) return objective;
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }
  if (parsedSlash?.name === "plan") {
    const prompt = handlePlanCommand(ws, sessionId, entry, parsedSlash.args);
    if (prompt !== null) return prompt;
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }

  // 3) builtin：41 条无 TUI 执行的命令。桌面 prompt RPC 立即返回、turn 产物全走
  // 常驻事件订阅（与 RPC 模式同构），不需要 keepTurnOpenUntilIdle；但 /compact、/handoff、
  // /rename（无参自动生成标题）等 provider-backed 命令需要 runCommandInBackground——否则
  // 底座内联 await，压缩几十秒期间 UI 无任何反馈且 abort 被卡住（对齐 RPC 模式做法）。
  // 后台命令完成后会话条目会被改写：按指纹检测变化，重建 transcript 推 messages 全量帧
  // 刷新视图；执行期间底座 output 的完成文案先缓存，待视图重建后补发（否则会被冲掉）。
  const entriesSig = (list: any[]) => list.length + ":" + (list[list.length - 1]?.id ?? "");
  const baseline = entriesSig(entry.manager.getEntries());
  let bgOutputs: string[] | null = null; // 非 null = 后台命令执行中，output 暂存
  let bgSucceeded = false; // 后台任务跑出底座成功文案（没跑出 = 中止/静默失败）
  const phaseKey = trimmed.split(/\s+/)[0].replace(/^\//, "");
  const phaseText = PHASE_TEXT[phaseKey];
  // 成功判定：底座完成输出的固定前缀（成功必发其一；无输出 = 中止/失败 → 撤执行中行）
  const phaseSuccess: Record<string, RegExp> = {
    compact: /^Compaction complete/,
    handoff: /^Context handed off and compacted in place\./,
    rename: /^Session renamed to /,
  };
  const runtime: SlashCommandRuntime = {
    session: entry.session,
    sessionManager: entry.session.sessionManager,
    settings: entry.session.settings,
    cwd: entry.session.sessionManager.getCwd(),
    output: (t) => {
      if (bgOutputs) {
        if (phaseSuccess[phaseKey].test(t)) bgSucceeded = true;
        bgOutputs.push(t);
        return;
      }
      ws.send(JSON.stringify({ type: "command_output", sessionId, text: t }));
    },
    refreshCommands: () => pushCommands(ws, sessionId, entry),
    reloadPlugins: () => pushCommands(ws, sessionId, entry),
    runCommandInBackground: (task) => {
      if (bgOutputs === null) {
        bgOutputs = [];
        // 耗时命令的起始分隔行：否则气泡撤回后界面毫无动静（压缩/交接在后台跑）
        ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "start", command: phaseKey, text: phaseText[0] }));
      }
      void task()
        .then(async () => {
          const entries = entry.manager.getEntries();
          if (entriesSig(entries) !== baseline) {
            entry.transcript = entriesToTranscript(entries);
            entry.mentionScanIndex = entries.length; // 回读游标对齐，避免重发历史 mention
            ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
            pushContext(ws, sessionId, entry);
          }
          await handleListSessions(ws); // 标题/列表可能变（rename/handoff 改标题）
          const outs = bgOutputs ?? [];
          bgOutputs = null;
          // 成功：落盘痕已写入，下方 messages 重建帧自带完成分隔行（UI 按 command 吸收执行中行），
          // 不再发 done 瞬时帧；失败/中止：无痕可落，发 fail 撤掉执行中行，错误详情在 output 行里
          if (!bgSucceeded) ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          for (const t of outs) ws.send(JSON.stringify({ type: "command_output", sessionId, text: t }));
        })
        .catch((err: unknown) => {
          bgOutputs = null;
          ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          ws.send(JSON.stringify({ type: "command_output", sessionId, text: `命令执行失败: ${err instanceof Error ? err.message : String(err)}` }));
        });
    },
    notifyTitleChanged: () => {
      void handleListSessions(ws);
    },
    notifyConfigChanged: () => {
      ws.send(
        JSON.stringify({
          type: "session_model",
          sessionId,
          model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
          thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
        }),
      );
    },
  };
  const r = await executeAcpBuiltinSlashCommand(trimmed, runtime);
  if (r === false) return text; // 不是 builtin → 原样走 prompt（文件/自定义/扩展命令由底座展开）
  if ("prompt" in r) return r.prompt; // /force <tool> <prompt> 之类：剩余文本当 prompt
  ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
  return null;
}

async function handlePrompt(
  ws: { send(data: string): unknown },
  sessionId: string,
  text: string,
  files?: PromptAttachment[],
  steer = false,
) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  // 附件：图片走 SDK ImageContent；文本类文件内容内联进 prompt（与 CLI 粘贴文件一致）
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const f of files ?? []) {
    if (f.kind === "image" && typeof f.data === "string") {
      images.push({ type: "image", data: f.data, mimeType: String(f.mime ?? "image/png") });
    }
  }
  const textBlocks = (files ?? [])
    .filter((f) => f.kind === "text" && typeof f.text === "string")
    .map((f) => {
      const name = String(f.name ?? "file").replace(/"/g, "&quot;");
      return `<attached-file name="${name}">\n${f.text}\n</attached-file>`;
    });
  let finalText = text;
  if (textBlocks.length > 0) {
    finalText = text ? `${textBlocks.join("\n\n")}\n\n${text}` : textBlocks.join("\n\n");
  }
  if (!finalText && images.length === 0) throw new Error("消息为空");
  if (!finalText) finalText = "请查看附件图片。";
  // 斜杠命令本地分发：消费则直接返回（不推 transcript、不调 prompt）；改写则继续
  const dispatched = await dispatchSlashInput(ws, sessionId, entry, finalText);
  if (dispatched === null) return;
  finalText = dispatched;
  entry.transcript.push({
    role: "user",
    text: finalText,
    ...(images.length > 0 ? { images } : {}),
  });
  // 自动会话标题：CLI 由 input-controller / main.ts 调用底座同一入口；SDK 宿主没有这层，
  // 必须自己触发。底座内部 gate 负责「已有标题 / 已在生成 / 低信号输入 / PI_NO_TITLE」跳过，
  // 生成的标题经 SessionManager.onSessionNameChanged → session_title_changed 帧下发。
  // 流式注入（steer / 排队 followUp）不触发，与 CLI 只在 idle 提交时起标题一致。
  if (!steer) entry.session.maybeStartTitleGeneration(finalText);
  // 命令立即返回；turn 产物全部走事件流。流式中的注入行为由 streamingBehavior 决定：
  // followUp = 排队（当前 loop 完全处理完后自动消费触发新 turn，不打断进行中的处理）；
  // steer = 立即注入（当前工具批次后插入，气泡转正并分割过程）。idle 时两者都被底座忽略照常开 turn。
  entry.session
    .prompt(finalText, {
      ...(images.length > 0 ? { images } : {}),
      streamingBehavior: steer ? "steer" : "followUp",
    })
    .then((agentInvoked: boolean) => {
      if (agentInvoked === false) {
        // 扩展/自定义/文件命令被底座本地消费：撤回乐观气泡与 transcript 条目
        // （该 user 消息必是尾部最后一条同文本且尚无 entryId 的）
        const i = entry.transcript.findLastIndex((t) => t.role === "user" && t.text === finalText && !t.entryId);
        if (i >= 0) entry.transcript.splice(i, 1);
        ws.send(JSON.stringify({ type: "command_result", sessionId, text: finalText, consumed: true }));
      }
      // 流式排队后立即修剪：底座队列只留最早 1 条，其余进 parked（本轮 run 的注入边界
      // 只能带走这 1 条，避免多条拼车；后续逐轮 agent_end 放回消费）
      parkFollowUpTail(entry);
      sendQueued(ws, sessionId, entry);
    }) // 入队/开 turn 后校准前端排队行
    .catch((err: unknown) => {
      ws.send(JSON.stringify(stampEvent({ type: "error", sessionId, message: String(err) })));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`会话不存在: ${sessionId}`);
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}

export const promptHandlers: Record<string, RpcHandler> = {
  async prompt(ws, msg) {
    // steer=true：流式中不排队而是立即注入（当前工具批次后），idle 时底座忽略该参数照常开 turn
    await handlePrompt(ws, msg.sessionId, String(msg.text ?? ""), msg.files, msg.steer === true);
  },
  peek_queued(ws, msg) {
    handlePeekQueued(ws, msg.sessionId);
  },
  drop_queued(ws, msg) {
    handleDropQueued(
      ws,
      msg.sessionId,
      msg.queue === "steering" ? "steering" : "followUp",
      msg.index === undefined ? undefined : Number(msg.index),
    );
  },
  async send_now(ws, msg) {
    await handleSendNow(ws, msg.sessionId, Number(msg.index));
  },
  requeue(ws, msg) {
    handleRequeue(ws, msg.sessionId, Number(msg.index));
  },
  get_messages(ws, msg) {
    handleGetMessages(ws, msg.sessionId);
  },
  get_todos(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    ws.send(JSON.stringify({ type: "todos", sessionId: msg.sessionId, phases: entry.session.getTodoPhases() }));
  },
  async bash_exec(ws, msg) {
    // ! 本地命令：结果走 bashExecution 落盘（底座 executeBash 内部完成），
    // 实时流由专用帧驱动（bash_start/chunk/done），不进模型事件流
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    const command = String(msg.command ?? "").trim();
    if (!command) return;
    const excludeFromContext = msg.excludeFromContext === true;
    if (entry.session.isBashRunning) {
      ws.send(
        JSON.stringify({
          type: "error",
          sessionId: msg.sessionId,
          message: "已有 bash 命令在执行，先按停止或等它结束",
        }),
      );
      return;
    }
    const item: TranscriptItem = { role: "bash", text: command, output: "", running: true, excludeFromContext };
    entry.transcript.push(item);
    ws.send(JSON.stringify({ type: "bash_start", sessionId: msg.sessionId, command, excludeFromContext }));
    entry.session
      .executeBash(
        command,
        (chunk) => ws.send(JSON.stringify({ type: "bash_chunk", sessionId: msg.sessionId, chunk })),
        { excludeFromContext, useUserShell: true },
      )
      .then((r) => {
        item.output = r.output;
        item.running = false;
        item.exitCode = r.exitCode ?? null;
        item.cancelled = r.cancelled;
        item.timedOut = r.timedOut === true;
        item.truncated = r.truncated;
        // 底座 lazy 门：纯 ! 会话（无 assistant 消息）不落盘，重开会话会丢 bash 行。
        // 用户既然执行了命令，这里显式跨门让整份内存 entries（含本条）写盘。
        entry.manager.ensureOnDisk?.().catch((err: unknown) => {
          process.stderr.write(`[host] ensureOnDisk 失败: ${String(err)}\n`);
        });
        ws.send(
          JSON.stringify({
            type: "bash_done",
            sessionId: msg.sessionId,
            exitCode: r.exitCode ?? null,
            cancelled: r.cancelled,
            timedOut: r.timedOut === true,
            truncated: r.truncated,
            output: r.output,
          }),
        );
      })
      .catch((err: unknown) => {
        item.running = false;
        ws.send(
          JSON.stringify({
            type: "bash_done",
            sessionId: msg.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  },
  bash_abort(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    entry.session.abortBash(); // 同步触发；executeBash 的 promise 会自行 resolve 并再发一帧 bash_done
    ws.send(JSON.stringify({ type: "bash_done", sessionId: msg.sessionId, cancelled: true }));
  },
  async list_commands(ws, msg) {
    // 斜杠命令清单（输入框 / 补全用）：按需拉取，不做会话生命周期推送。
    // 无 sessionId = 新建会话页请求（隐藏会话级命令，见 pushNewSessionCommands）
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    if (entry) {
      await pushCommands(ws, msg.sessionId, entry);
    } else {
      await pushNewSessionCommands(ws, msg.cwd ? String(msg.cwd) : defaultCwd);
    }
  },
  async list_files(ws, msg) {
    // @ 文件候选：reqId 原样回传，前端据此丢弃过期响应
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    const root = entry ? entry.session.sessionManager.getCwd() : String(msg.cwd ?? "");
    if (!root) throw new Error("缺少 cwd");
    const query = String(msg.query ?? "");
    ws.send(
      JSON.stringify({
        type: "file_matches",
        reqId: msg.reqId,
        matches: await listFileMatches(root, query),
      }),
    );
  },
};
