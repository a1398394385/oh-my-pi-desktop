// /btw side conversations: multiple concurrent topics per session, each topic a serialized
// chain of ephemeral turns run against the session's current model + history snapshot.
// Built on the SDK's btw-turn/btw-history primitives (same sidecar files the TUI reads and
// continues). Unlike the base RpcBtwController (single-flight), topics run in parallel here;
// within one topic turns are strictly serialized: runBtwTurn replays the topic history and
// checkpoints CAS against the sidecar, so two concurrent turns on one topic would clobber
// each other's records.
// Deliberate simplification vs the base controller: no in-process unsaved-write retry table.
// The desktop host is a single process and the sole writer of its topics; a failed terminal
// checkpoint is logged + surfaced as an error frame, and the next topic operation reopens the
// store fresh from disk (crash recovery marks running turns "interrupted").
import type { BtwHistoryRecord, BtwHistoryTurn } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { BtwHistoryStore, beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "./bootstrap.ts";
import { sessions, stampEvent, entryBus } from "./state.ts";
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

type BtwWs = { send(data: string): unknown };

interface TopicRun {
  record: BtwHistoryRecord;
  store: BtwHistoryStore;
  abort: AbortController;
}

interface BtwState {
  /** Topic ids between RPC intake and their first checkpoint (cancelled via epoch bump). */
  starting: Set<string>;
  /** Live topic runs keyed by record id. */
  running: Map<string, TopicRun>;
  /** Bumped by every cancel; an ask still crossing an await gap gives up. */
  epoch: number;
}

const states = new Map<string, BtwState>();

function stateFor(sessionId: string): BtwState {
  let st = states.get(sessionId);
  if (!st) {
    st = { starting: new Set(), running: new Map(), epoch: 0 };
    states.set(sessionId, st);
  }
  return st;
}

function managerOf(sessionId: string) {
  const e = sessions.get(sessionId);
  if (!e) throw new Error(`Session not found: ${sessionId}`);
  return e.session.sessionManager as {
    getArtifactsDir(): string | null;
    getSessionId(): string;
    getLeafId(): string | null;
  };
}

function sessionOf(sessionId: string) {
  const e = sessions.get(sessionId);
  if (!e) throw new Error(`Session not found: ${sessionId}`);
  return e.session as { model: unknown; runEphemeralTurn: Function };
}

/** Push the topic's current state to the UI; every lifecycle transition lands through here.
 * Fans out over the session's uiSockets: the Side Chat panel is per-session shared state,
 * so the other attached channel sees the same topic stream. */
function pushRecord(_ws: BtwWs, sessionId: string, record: BtwHistoryRecord): void {
  entryBus(sessions.get(sessionId)!).send(JSON.stringify(stampEvent({ type: "btw_record", sessionId, record })));
}

async function openStore(sessionId: string): Promise<BtwHistoryStore> {
  const manager = managerOf(sessionId);
  return BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined, manager.getSessionId());
}

/**
 * Start a question (new topic when `recordId` is omitted, a follow-up turn on that topic
 * otherwise). Resolves once the turn is checkpointed as running; the model turn streams
 * afterwards. Topics run concurrently; a topic with a live turn rejects new ones.
 */
export async function btwAsk(ws: BtwWs, sessionId: string, question: string, recordId?: string): Promise<void> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error(hostI18n.t("errors.btw.emptyQuestion"));
  const st = stateFor(sessionId);
  const previous =
    recordId === undefined ? undefined : (await openStore(sessionId)).getRecords().find((r: BtwHistoryRecord) => r.id === recordId);
  if (recordId !== undefined && !previous) throw new Error(hostI18n.t("errors.btw.topicNotFound", { recordId }));
  if (recordId !== undefined && st.running.has(recordId)) throw new Error(hostI18n.t("errors.btw.stillRunning"));
  if (!sessionOf(sessionId).model) throw new Error(hostI18n.t("errors.btw.noModel"));

  const epoch = st.epoch;
  // beginBtwTurn is synchronous: registered as starting so a cancel racing the await gaps
  // below aborts via the epoch instead of leaving an orphaned turn.
  const { record, history, conversationKey } = beginBtwTurn(trimmed, managerOf(sessionId).getLeafId(), previous);
  st.starting.add(record.id);
  try {
    const store = await openStore(sessionId);
    if (epoch !== st.epoch) throw new Error(hostI18n.t("errors.btw.cancelledEarly"));
    await store.upsert(record);
    const run: TopicRun = { record, store, abort: new AbortController() };
    st.running.set(record.id, run);
    pushRecord(ws, sessionId, record);
    if (epoch !== st.epoch) {
      finish(st, run, { status: "cancelled", updatedAt: Date.now() });
      pushRecord(ws, sessionId, run.record);
      throw new Error(hostI18n.t("errors.btw.cancelledEarly"));
    }
    void runTopic(ws, sessionId, st, run, trimmed, history, conversationKey);
  } finally {
    st.starting.delete(record.id);
  }
}

async function runTopic(
  ws: BtwWs,
  sessionId: string,
  st: BtwState,
  run: TopicRun,
  question: string,
  history: readonly BtwHistoryTurn[] | undefined,
  conversationKey: string,
): Promise<void> {
  try {
    const { replyText } = await runBtwTurn(sessionOf(sessionId) as Parameters<typeof runBtwTurn>[0], {
      question,
      history,
      conversationKey,
      signal: run.abort.signal,
      onTextDelta: (delta: string) => {
        if (st.running.get(run.record.id) !== run) return;
        run.record = patchLatestBtwTurn(run.record, { answer: run.record.answer + delta, updatedAt: Date.now() });
        entryBus(sessions.get(sessionId)!).send(JSON.stringify({ type: "btw_delta", sessionId, recordId: run.record.id, delta }));
      },
    });
    finish(st, run, { answer: replyText, status: "complete", updatedAt: Date.now() });
  } catch (error) {
    finish(st, run, { status: "error", error: String((error as Error)?.message ?? error), updatedAt: Date.now() });
  }
  pushRecord(ws, sessionId, run.record);
  try {
    await run.store.upsert(run.record);
  } catch (error) {
    safeStderr(`[btw] terminal checkpoint failed for ${run.record.id}: ${error}\n`);
    entryBus(sessions.get(sessionId)!).send(JSON.stringify({ type: "error", message: `Could not save /btw history: ${(error as Error)?.message ?? error}` }));
  }
}

/** Record the turn's terminal state once; later outcomes of the same turn are ignored. */
function finish(st: BtwState, run: TopicRun, patch: Partial<BtwHistoryTurn>): void {
  if (st.running.get(run.record.id) !== run) return;
  st.running.delete(run.record.id);
  run.record = patchLatestBtwTurn(run.record, patch);
}

/** Cancel the live turn of one topic (or every topic when `recordId` is omitted). */
export function btwCancel(ws: BtwWs, sessionId: string, recordId?: string): void {
  const st = stateFor(sessionId);
  st.epoch++;
  for (const run of [...st.running.values()]) {
    if (recordId !== undefined && run.record.id !== recordId) continue;
    finish(st, run, { status: "cancelled", updatedAt: Date.now() });
    run.abort.abort();
    pushRecord(ws, sessionId, run.record);
    void run.store.upsert(run.record).catch((error) => safeStderr(`[btw] cancel checkpoint failed for ${run.record.id}: ${error}\n`));
  }
}

/** Newest-first topic list, re-read from disk each call (single writer: the host process). */
export async function collectBtwHistory(sessionId: string): Promise<BtwHistoryRecord[]> {
  const live = stateFor(sessionId);
  const records = new Map<string, BtwHistoryRecord>(
    (await openStore(sessionId)).getRecords().map((r: BtwHistoryRecord) => [r.id, r] as [string, BtwHistoryRecord]),
  );
  for (const run of live.running.values()) records.set(run.record.id, run.record);
  return [...records.values()].sort(
    (a: BtwHistoryRecord, b: BtwHistoryRecord) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}
