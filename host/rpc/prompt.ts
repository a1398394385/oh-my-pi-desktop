// Message-send domain RPCs: prompt (attachment assembly / slash dispatch /
// queue trimming), queued-message operations, local bash, and composer sigil
// candidates (slash command list / @ file matches). Relocated from the
// message dispatch in main.ts (third cut).
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
  discoverSkills,
} from "../bootstrap.ts";
import { H, sessions, defaultCwd, stampEvent, type PoolEntry, type TranscriptItem } from "../state.ts";
import { entriesToTranscript, PHASE_TEXT } from "../translate.ts";
import { pushContext } from "../session-lifecycle.ts";
import { handlePlanCommand } from "../plan.ts";
import { sendQueued, parkFollowUpTail, handlePeekQueued, handleDropQueued, handleSendNow, handleRequeue } from "../queue.ts";
import { handleListSessions } from "./session";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";
import { settingsGet } from "../settings-compat.ts";

// Attachments sent by the frontend along with prompt: images as base64, text-kind as file contents
interface PromptAttachment {
  kind: "image" | "text";
  mime?: string;
  data?: string; // image: base64 (no data: prefix)
  name?: string; // text: file name
  text?: string; // text: file contents
}

// ---------- Composer sigils: command list and @ file candidates ----------

// Slash commands the desktop does not offer via the sigil: model / thinking
// level / session toggles, whose capabilities are carried by the composer
// capsules (model/thinking/ModeMenu) and the settings page instead. Both the
// list filter and the execution intercept share this table (values are the
// hit hints). Keys include aliases (/models aliases /model; /force:xxx is
// folded into force by parseSlashCommand).
// Values are i18n keys (truthy membership check doubles as the list filter).
const REMOVED_SLASH_COMMANDS: Record<string, string> = {
  model: "errors.removedCmd.useModelCapsule",
  models: "errors.removedCmd.useModelCapsule",
  switch: "errors.removedCmd.useModelCapsule",
  prewalk: "errors.removedCmd.prewalkRemoved",
  fast: "errors.removedCmd.fastRemoved",
  skillful: "errors.removedCmd.skillsSettingPage",
  "extended-context": "errors.removedCmd.extContextSettingPage",
  computer: "errors.removedCmd.computerSettingPage",
  force: "errors.removedCmd.forceRemoved",
  fork: "errors.removedCmd.useForkButton",
};

/** Hint text for removed commands; returns null for commands that were not removed */
function removedSlashHint(text: string): string | null {
  const parsed = parseSlashCommand(text.trim());
  if (!parsed) return null;
  const hintKey = REMOVED_SLASH_COMMANDS[parsed.name];
  return hintKey ? hostI18n.t("errors.removedCmd.template", { command: parsed.name, hint: hostI18n.t(hintKey) }) : null;
}

// Session-level commands hidden on the new-session page: they operate on /
// report "an already existing session" and are meaningless before the first
// message is sent (compact/handoff/retry/session management/export/stats
// etc.). goal, memory, tool & plugin management, skill:* etc. are kept.
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

// /goal: the base's entry is TUI-only (no handle, so it stays out of the list); inject a same-named desktop entry (execution goes through dispatchSlashInput)
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

// /plan: likewise the base only has handleTui (buildAvailableSlashCommands's
// `if (!command.handle) continue` keeps it out of the list, and typing it by
// hand would be sent to the model as a plain prompt); inject a same-named
// desktop entry.
const PLAN_SLASH_COMMAND = {
  name: "plan",
  description: "Toggle plan mode (agent plans before executing)",
  input: { hint: "[prompt]" },
  source: "builtin" as const,
};

// Command list frame: builtin + skill + extension + custom + file commands —
// the batch that can execute without a TUI (the sister face of
// executeAcpBuiltinSlashCommand). Mapped into the shape the frontend's
// PaletteMenu consumes directly.
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

// Command list for the new-session page (no session entry): skills / custom
// commands borrow any pooled session (same config loading, identical across
// sessions); file commands scan the new project's cwd; session-level
// commands are hidden. With an empty pool, skills run the same discovery a
// session would (discoverSkills) — the creating-new page must still offer
// skill candidates ($ / /skill: completion) on a cold host.
async function pushNewSessionCommands(ws: { send(data: string): unknown }, cwd: string) {
  const any = sessions.values().next().value as PoolEntry | undefined;
  let skills = any?.session.skills as unknown;
  if (!skills) {
    skills = (
      await discoverSkills(cwd, H.agentDir, {
        ...H.settings.getGroup("skills"),
        disabledExtensions: settingsGet(H.settings, "disabledExtensions") ?? [],
      })
    ).skills;
  }
  const stub = {
    customCommands: any?.session.customCommands ?? [],
    skills,
    skillsSettings: any?.session.skillsSettings ?? { enableSkillCommands: true },
    setSlashCommands: () => {},
    sessionManager: { getCwd: () => cwd },
  } as unknown as AvailableCommandsSession;
  sendCommandsFrame(ws, null, await buildAvailableSlashCommands(stub), true);
}

// @ candidates: absolute-path / home-dir prefixes go through readdir prefix
// listing (matching the TUI autocomplete's directory completion); everything
// else goes through fuzzyFind whole-repo fuzzy search; any error silently
// returns empty (the popup shows no match)
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

// ---------- Local slash-command dispatch ----------
// Order matches ACP #runPromptOrCommand: /skill: → builtin
// (executeAcpBuiltinSlashCommand) → pass through to prompt as-is.
// Returning null = consumed locally (no prompt call, no user transcript
// push); returning a string = continue through prompt with that text.
// prompt() itself also expands file commands / custom TS commands /
// extension commands (the agentInvoked=false signal is handled in then).
async function dispatchSlashInput(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  text: string,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return text;

  // 1) /skill:<name>: the base's prompt() does not handle it, the host must dispatch (matching ACP #tryRunSkillCommand)
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

  // 2) Removed commands: neither executed nor turned into a prompt (the list is already filtered in pushCommands; this intercepts hand-typed input)
  const removedHint = removedSlashHint(trimmed);
  if (removedHint) {
    ws.send(JSON.stringify({ type: "command_output", sessionId, text: removedHint }));
    ws.send(JSON.stringify({ type: "command_result", sessionId, text: trimmed, consumed: true }));
    return null;
  }

  // 2.5) /goal, /plan: desktop implementations (the base has only handleTui
  // for both, executeAcpBuiltinSlashCommand will not take them). A returned
  // text goes through the normal prompt chain (transcript/queueing reused);
  // null = consumed
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

  // 3) builtin: the 41 commands executable without a TUI. The desktop's
  // prompt RPC returns immediately and all turn output flows through the
  // resident event subscription (isomorphic to RPC mode), so no
  // keepTurnOpenUntilIdle; but provider-backed commands like /compact,
  // /handoff, /rename (title auto-generated when no arg) need
  // runCommandInBackground — otherwise the base awaits inline, leaving the
  // UI with zero feedback for the tens of seconds a compaction takes and
  // abort wedged (matching the RPC-mode approach). After a background
  // command finishes, session entries have been rewritten: detect the change
  // by fingerprint, rebuild the transcript, and push a full messages frame
  // to refresh the view; the base's completion output during execution is
  // buffered first and re-sent after the view rebuild (otherwise it would
  // be washed away).
  const entriesSig = (list: any[]) => list.length + ":" + (list[list.length - 1]?.id ?? "");
  const baseline = entriesSig(entry.manager.getEntries());
  let bgOutputs: string[] | null = null; // Non-null = a background command is running, output buffered
  let bgSucceeded = false; // The background task produced the base's success line (no line = aborted/silent failure)
  const phaseKey = trimmed.split(/\s+/)[0].replace(/^\//, "");
  const phaseText = PHASE_TEXT[phaseKey];
  // Success detection: fixed prefixes of the base's completion output (a success always emits one of them; no output = aborted/failed → retract the in-progress row)
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
        // Start separator row for long-running commands: without it the UI looks dead after the bubble is retracted (compact/handoff run in the background)
        ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "start", command: phaseKey, text: phaseText[0] }));
      }
      void task()
        .then(async () => {
          const entries = entry.manager.getEntries();
          if (entriesSig(entries) !== baseline) {
            entry.transcript = entriesToTranscript(entries);
            entry.mentionScanIndex = entries.length; // Align the read-back cursor, avoiding re-sending historical mentions
            ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
            pushContext(ws, sessionId, entry);
          }
          await handleListSessions(ws); // Title/list may have changed (rename/handoff alter titles)
          const outs = bgOutputs ?? [];
          bgOutputs = null;
          // Success: the disk trace is written and the messages rebuild frame
          // below carries its own completion separator row (the UI absorbs
          // the in-progress row by command), so no done transient frame is
          // sent; failure/abort: no trace to write, send fail to retract the
          // in-progress row, error details live in the output rows
          if (!bgSucceeded) ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          for (const t of outs) ws.send(JSON.stringify({ type: "command_output", sessionId, text: t }));
        })
        .catch((err: unknown) => {
          bgOutputs = null;
          ws.send(JSON.stringify({ type: "command_phase", sessionId, phase: "fail", command: phaseKey }));
          ws.send(JSON.stringify({ type: "command_output", sessionId, text: hostI18n.t("errors.commandFailed", { detail: err instanceof Error ? err.message : String(err) }) }));
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
  if (r === false) return text; // Not a builtin → pass through to prompt as-is (file/custom/extension commands are expanded by the base)
  if ("prompt" in r) return r.prompt; // E.g. /force <tool> <prompt>: the remaining text becomes the prompt
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
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  // The user sending a message in this session = a seen interaction: clear the cache-keepalive unread state (this turn's wrap-up will set it again)
  entry.keepaliveWanted = false;
  // Attachments: images go through SDK ImageContent; text-kind file contents are inlined into the prompt (same as pasting files in the CLI)
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
  if (!finalText && images.length === 0) throw new Error(hostI18n.t("errors.prompt.emptyMessage"));
  if (!finalText) finalText = hostI18n.t("errors.prompt.imageOnlyFallback");
  // Local slash-command dispatch: if consumed, return directly (no transcript push, no prompt call); if rewritten, continue
  const dispatched = await dispatchSlashInput(ws, sessionId, entry, finalText);
  if (dispatched === null) return;
  finalText = dispatched;
  entry.transcript.push({
    role: "user",
    text: finalText,
    ...(images.length > 0 ? { images } : {}),
  });
  // Auto session title: the CLI calls the base's same entry from
  // input-controller / main.ts; the SDK host has no such layer and must
  // trigger it itself. The base's internal gate skips "already titled /
  // already generating / low-signal input / PI_NO_TITLE"; the generated
  // title arrives via SessionManager.onSessionNameChanged → the
  // session_title_changed frame. Streaming injections (steer / queued
  // followUp) do not trigger it, matching the CLI only titling on idle
  // commits.
  if (!steer) entry.session.maybeStartTitleGeneration(finalText);
  // The command returns immediately; all turn output flows through the event
  // stream. Injection behavior mid-stream is decided by streamingBehavior:
  // followUp = queued (auto-consumed to trigger a new turn after the current
  // loop fully finishes, without interrupting in-flight work);
  // steer = injected immediately (inserted after the current tool batch, the
  // bubble finalized and the process split). When idle, the base ignores
  // both and opens a turn as usual.
  entry.session
    .prompt(finalText, {
      ...(images.length > 0 ? { images } : {}),
      streamingBehavior: steer ? "steer" : "followUp",
    })
    .then((agentInvoked: boolean) => {
      if (agentInvoked === false) {
        // An extension/custom/file command was consumed locally by the base:
        // retract the optimistic bubble and the transcript entry (that user
        // message is necessarily the last tail entry with the same text and
        // no entryId yet)
        const i = entry.transcript.findLastIndex((t) => t.role === "user" && t.text === finalText && !t.entryId);
        if (i >= 0) entry.transcript.splice(i, 1);
        ws.send(JSON.stringify({ type: "command_result", sessionId, text: finalText, consumed: true }));
      }
      // Trim right after queued-mid-stream: keep only the earliest 1 entry
      // in the base queue, park the rest (this run's injection boundary can
      // only carry that 1, avoiding several riding together; later agent_end
      // rounds put them back one by one for consumption)
      parkFollowUpTail(entry);
      sendQueued(ws, sessionId, entry);
    }) // Calibrate the frontend's queued rows after enqueueing/turn start
    .catch((err: unknown) => {
      ws.send(JSON.stringify(stampEvent({ type: "error", sessionId, message: String(err) })));
    });
}

function handleGetMessages(ws: any, sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
  ws.send(JSON.stringify({ type: "messages", sessionId, messages: entry.transcript }));
}


// ---------- Word completion (18.4.9 ghost text) ----------
// One predictor per process, the base RPC layer's own flow control (one
// engine request in flight; a newer request replaces the one waiting). The
// engine method follows the spelling.autocomplete setting exactly like the
// TUI's predict_word. Dynamic import because a static one would hoist the SDK
// graph above bootstrap's setProfile (profile red line).
let wordPredictor: { predict(method: unknown, text: string, cursor: number): Promise<string | null> } | undefined;
async function predictWordSuffix(text: string): Promise<string | null> {
  if (!wordPredictor) {
    const { RpcWordPredictor } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode");
    wordPredictor = new RpcWordPredictor();
  }
  // Layered setting read returns the engine id ("off" disables); the
  // predictor's own signature narrows it on the SDK side
  return wordPredictor.predict(settingsGet(H.settings, "spelling.autocomplete"), text, text.length);
}

export const promptHandlers: Record<string, RpcHandler> = {
  async prompt(ws, msg) {
    // steer=true: mid-stream, inject immediately instead of queueing (after the current tool batch); when idle the base ignores the flag and opens a turn as usual
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
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    ws.send(JSON.stringify({ type: "todos", sessionId: msg.sessionId, phases: entry.session.getTodoPhases() }));
  },
  async bash_exec(ws, msg) {
    // ! local command: the result is persisted as a bashExecution entry (done
    // inside the base's executeBash); the live stream is driven by dedicated
    // frames (bash_start/chunk/done), not the model event stream
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const command = String(msg.command ?? "").trim();
    if (!command) return;
    const excludeFromContext = msg.excludeFromContext === true;
    if (entry.session.isBashRunning) {
      ws.send(
        JSON.stringify({
          type: "error",
          sessionId: msg.sessionId,
          message: hostI18n.t("errors.bash.busy"),
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
        // The base's lazy gate: a pure-! session (no assistant messages) is
        // not persisted, so reopening the session would lose the bash rows.
        // Since the user ran a command, explicitly cross the gate so the full
        // in-memory entries (including this one) are written to disk.
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
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    entry.session.abortBash(); // Triggered synchronously; executeBash's promise resolves on its own and sends another bash_done frame
    ws.send(JSON.stringify({ type: "bash_done", sessionId: msg.sessionId, cancelled: true }));
  },
  async list_commands(ws, msg) {
    // Slash command list (for composer / completion): fetched on demand, no
    // session-lifecycle push. No sessionId = a new-session page request
    // (session-level commands hidden; see pushNewSessionCommands)
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    if (entry) {
      await pushCommands(ws, msg.sessionId, entry);
    } else {
      await pushNewSessionCommands(ws, msg.cwd ? String(msg.cwd) : defaultCwd);
    }
  },
  async list_files(ws, msg) {
    // @ file candidates: reqId is echoed back so the frontend can discard stale responses
    const entry = msg.sessionId ? sessions.get(msg.sessionId) : undefined;
    const root = entry ? entry.session.sessionManager.getCwd() : String(msg.cwd ?? "");
    if (!root) throw new Error(hostI18n.t("errors.param.missingCwd"));
    const query = String(msg.query ?? "");
    ws.send(
      JSON.stringify({
        type: "file_matches",
        reqId: msg.reqId,
        matches: await listFileMatches(root, query),
      }),
    );
  },
  async complete_text(ws, msg) {
    // Ghost-text completion for the composer draft: cursor is the draft's end
    // (contract v1 carries text only). Best-effort — engine off, no
    // prediction, a superseding request, or an unreachable prediction daemon
    // all answer an empty suggestion instead of an error frame.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const text = String(msg.text ?? "");
    let suggestion = "";
    if (text) {
      try {
        suggestion = (await predictWordSuffix(text)) ?? "";
      } catch {
        // Prediction daemon unavailable: no ghost text this round
      }
    }
    ws.send(JSON.stringify(stampEvent({ type: "completion", sessionId: msg.sessionId, suggestion })));
  },
};
