// Composer predictions (composer.predictions, composer.predictionAlternatives): after a turn ends
// on its own, ask the session's own model for the message the user is likely to send next and push
// the choices; the UI paints them as ghost text while the draft is empty.
//
// Mirrors the base ComposerPredictionController (modes/controllers/composer-prediction-controller.ts):
// one ephemeral side turn on the session's model and context (same prompt prefix, so it reads the
// prompt cache), parsed to at most MAX_CHOICES distinct lines, billed through the session journal
// under the `composer-prediction` purpose. The base's telemetry is not ported.
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { readSdkPrompt } from "./bootstrap.ts";
import { settingsGet } from "./settings-compat.ts";
import { entryBus, stampEvent, type PoolEntry } from "./state.ts";
import { safeStderr } from "./stderr.ts";

/** Reply the prompt asks for when the model has no confident guess. */
const SKIP_REPLY = "NO_PREDICTION";
/** Most alternatives one request asks for and the composer offers. */
const MAX_CHOICES = 4;
/** Longer replies are rambling, not a message the user would type. */
const MAX_PREDICTION_LENGTH = 500;
/** Output cap for the side turn; sent only where it leaves the request cache intact. */
const PREDICTION_MAX_TOKENS = 1024;
/** A prediction that has not arrived by then is no longer worth paying for or showing. */
const PREDICTION_DEADLINE_MS = 15_000;
const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/;
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** Pending request per session id (superseding call aborts the earlier one). */
const inFlight = new Map<string, AbortController>();

/** Normalize one prediction to the single line the composer shows, or undefined when unusable. */
export function parsePrediction(reply: string): string | undefined {
  let text = sanitizeText(reply).replace(/\s+/g, " ").trim();
  const quoted = WRAPPING_QUOTES.exec(text);
  if (quoted) text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").trim();
  if (!text || text.includes(SKIP_REPLY) || text.length > MAX_PREDICTION_LENGTH) return undefined;
  return text;
}

/**
 * Normalize an alternatives reply (one message per line, most likely first) to at most `max`
 * distinct lines. List markers and wrapping quotes are stripped per line; a leading preamble line
 * ending in a colon, rambling lines, repeats (case/punctuation folded) and the skip reply are
 * dropped. A skip in the first line declines the whole prediction.
 */
export function parsePredictions(reply: string, max: number): string[] | undefined {
  const lines = reply
    .split(/\r?\n/)
    .map((raw) => raw.replace(LIST_MARKER, ""))
    .filter((line) => line.trim());
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    if (choices.length === max) break;
    if (choices.length === 0 && line.includes(SKIP_REPLY)) return undefined;
    const text = parsePrediction(line);
    if (!text) continue;
    // "Here are some options:" introducing the alternatives below it
    if (i === 0 && i < lines.length - 1 && text.endsWith(":")) continue;
    const key = text.toLowerCase().replace(NON_WORD, " ").trim() || text;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(text);
  }
  return choices.length > 0 ? choices : undefined;
}

/** Abort this session's in-flight prediction (a new turn or prompt supersedes it). */
export function cancelPrediction(sessionId: string): void {
  inFlight.get(sessionId)?.abort();
  inFlight.delete(sessionId);
}

/**
 * Predict the next message after a turn ended on its own. Gated on the settings and a stopped
 * (not aborted, not failed) assistant reply; every skip also clears the previous ghost.
 */
export function requestPrediction(entry: PoolEntry, sessionId: string): void {
  cancelPrediction(sessionId);
  const session = entry.session;
  if (settingsGet(session.settings, "composer.predictions") !== true) return;
  if (!session.model || session.isStreaming || session.isCompacting) return;
  const last = session.messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop") return;
  const alternatives = settingsGet(session.settings, "composer.predictionAlternatives") === true;
  const abort = new AbortController();
  inFlight.set(sessionId, abort);
  void run(entry, sessionId, abort, last, alternatives);
}

async function run(
  entry: PoolEntry,
  sessionId: string,
  abort: AbortController,
  last: unknown,
  alternatives: boolean,
): Promise<void> {
  const session = entry.session;
  const manager = session.sessionManager;
  const owner = { sessionId: manager.getSessionId(), parentId: manager.getLeafId() };
  const deadline = AbortSignal.timeout(PREDICTION_DEADLINE_MS);
  try {
    const { replyText, assistantMessage } = await session.runEphemeralTurn({
      promptText: prompt.render(readSdkPrompt("composer-prediction-user.md"), {
        skip: SKIP_REPLY,
        choices: alternatives ? MAX_CHOICES : undefined,
      }),
      maxTokens: session.ephemeralMaxTokensPreservesRequest() ? PREDICTION_MAX_TOKENS : undefined,
      minimizeEffort: true,
      signal: AbortSignal.any([abort.signal, deadline]),
    });
    // Billed even when the reply is too late (or stale) to show: /stats counts real spend
    manager.appendModelUsage(
      {
        purpose: "composer-prediction",
        api: assistantMessage.api,
        provider: assistantMessage.provider,
        model: assistantMessage.model,
        usage: assistantMessage.usage,
        stopReason: assistantMessage.stopReason,
      },
      owner,
    );
    if (inFlight.get(sessionId) !== abort) return;
    // The conversation moved on (new message, session switch, compaction): the guess is stale
    if (session.messages.at(-1) !== last) return;
    const choices = alternatives
      ? parsePredictions(replyText, MAX_CHOICES)
      : (() => {
          const one = parsePrediction(replyText);
          return one === undefined ? undefined : [one];
        })();
    entryBus(entry).send(
      JSON.stringify(stampEvent({ type: "event", sessionId, kind: "prediction", choices: choices ?? [] })),
    );
  } catch (error) {
    // Superseded or expired predictions are expected outcomes, not failures
    if (abort.signal.aborted || deadline.aborted) return;
    safeStderr(`[prediction] composer prediction failed: ${String((error as Error)?.message ?? error)}\n`);
  } finally {
    if (inFlight.get(sessionId) === abort) inFlight.delete(sessionId);
  }
}
