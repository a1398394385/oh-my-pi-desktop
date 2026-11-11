// /btw side-conversation RPCs: ask (new topic or follow-up), cancel, history listing, and
// promote (graduate a finished topic into a real session seeded with its Q/A turns).
// Business logic lives in host/btw.ts; this table only narrows the wire boundary.
import { getBtwLatestTurn, SessionManager } from "../bootstrap.ts";
import { btwAsk, btwCancel, collectBtwHistory } from "../btw.ts";
import { attachEntry, createSessionCore } from "../session-lifecycle.ts";
import { sessions, stampEvent } from "../state.ts";
import { safeStderr } from "../stderr.ts";
import { hostI18n } from "../i18n/host.ts";
import { entriesToTranscript } from "../translate-history.ts";
import { refreshAllSessionLists } from "./session.ts";
import type { RpcHandler } from "./types";

export const btwHandlers: Record<string, RpcHandler> = {
  async btw_ask(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const recordId = msg.recordId === undefined || msg.recordId === null ? undefined : String(msg.recordId);
    await btwAsk(ws, sessionId, String(msg.question ?? ""), recordId);
  },

  btw_cancel(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const recordId = msg.recordId === undefined || msg.recordId === null ? undefined : String(msg.recordId);
    btwCancel(ws, sessionId, recordId);
  },

  async btw_history(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    ws.send(JSON.stringify(stampEvent({ type: "btw_history", sessionId, records: await collectBtwHistory(sessionId) })));
  },

  // Graduate a finished topic into a real session: fresh SessionManager seeded with the
  // topic's Q/A turns (plain text, not the btw prompt template), then pooled + announced
  // like any create. The sidecar topic stays in place (history intact); promote is
  // non-destructive and may be repeated (each run creates another session).
  async btw_promote(ws, msg) {
    const sessionId = String(msg.sessionId ?? "");
    const recordId = String(msg.recordId ?? "");
    const record = (await collectBtwHistory(sessionId)).find((r) => r.id === recordId);
    if (!record) throw new Error(hostI18n.t("errors.btw.topicNotFound", { recordId }));
    if (getBtwLatestTurn(record).status === "running") throw new Error(hostI18n.t("errors.btw.stillRunning"));
    const source = sessions.get(sessionId);
    if (!source) throw new Error(hostI18n.t("errors.session.notFound", { sessionId }));
    const model = source.session.model;
    if (!model) throw new Error(hostI18n.t("errors.btw.noModel"));

    const cwd = source.session.sessionManager.getCwd();
    const turns = [record, ...(record.followUps ?? [])];
    const manager = SessionManager.create(cwd);
    const zeroUsage = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const turn of turns) {
      const userMsg = {
        role: "user" as const, content: [{ type: "text" as const, text: turn.question }], attribution: "agent" as const, timestamp: turn.createdAt,
      };
      manager.appendMessage(userMsg);
      if (!turn.answer) continue;
      // Replay-shape assistant message (same construction the SDK uses when replaying saved
      // BTW answers): visible text only, zeroed usage, not a billed provider turn.
      const assistantMsg = {
        role: "assistant" as const, content: [{ type: "text" as const, text: turn.answer }],
        api: model.api, provider: model.provider, model: model.id, usage: zeroUsage,
        stopReason: "stop" as const, timestamp: turn.updatedAt,
      };
      manager.appendMessage(assistantMsg);
    }
    const title = String(msg.title ?? "").trim() || record.question;
    await manager.setSessionName(title, "user");
    // Flush before announcing: the sidebar lists sessions from disk, and a later
    // reopen rebuilds the transcript from that file.
    await manager.flush();
    // Build the transcript from the persisted entries (same source the load path
    // uses), not by hand: the hand-built rows lack the entry ids / turn-final
    // marks the renderer needs, so the chat column stayed empty.
    const transcript = entriesToTranscript(manager.getBranch(), manager.getSessionFile() ?? undefined);
    const { sessionId: newId, entry, eventBus } = await createSessionCore(cwd, manager, transcript, source.session.model);
    attachEntry(ws, newId, entry, eventBus);
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "session_created",
          sessionId: newId,
          path: entry.path,
          cwd,
          model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : null,
          thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
          isGit: entry.isGit,
          title: entry.title ?? null,
        }),
      ),
    );
    // The transcript rides the messages frame (the frontend rebuilds the chat
    // column from it); it must land after session_created, otherwise the store
    // has no slot for this session yet and drops the frame.
    ws.send(JSON.stringify({ type: "messages", sessionId: newId, messages: transcript }));
    // Sidebar refresh: without it the new session shows up only after the next
    // list push (pool snapshot / reload).
    await refreshAllSessionLists(ws);
    safeStderr(`[btw] promoted topic ${recordId} to session ${newId.slice(0, 8)}\n`);
  },
};
