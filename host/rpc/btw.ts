// /btw side-conversation RPCs: ask (new topic or follow-up), cancel, history listing, and
// promote (graduate a finished topic into a real session seeded with its Q/A turns).
// Business logic lives in host/btw.ts; this table only narrows the wire boundary.
import { getBtwLatestTurn, SessionManager } from "../bootstrap.ts";
import { btwAsk, btwCancel, collectBtwHistory } from "../btw.ts";
import { attachEntry, createSessionCore } from "../session-lifecycle.ts";
import { sessions, stampEvent, type TranscriptItem } from "../state.ts";
import { safeStderr } from "../stderr.ts";
import { hostI18n } from "../i18n/host.ts";
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
    const transcript: TranscriptItem[] = [];
    for (const turn of turns) {
      const userMsg = {
        role: "user", content: [{ type: "text", text: turn.question }], attribution: "agent", timestamp: turn.createdAt,
      };
      manager.appendMessage(userMsg);
      transcript.push({ role: "user", text: turn.question });
      if (!turn.answer) continue;
      // Replay-shape assistant message (same construction the SDK uses when replaying saved
      // BTW answers): visible text only, zeroed usage, not a billed provider turn.
      const assistantMsg = {
        role: "assistant", content: [{ type: "text", text: turn.answer }],
        api: model.api, provider: model.provider, model: model.id, usage: zeroUsage,
        stopReason: "stop", timestamp: turn.updatedAt,
      };
      manager.appendMessage(assistantMsg);
      transcript.push({ role: "assistant", text: turn.answer });
    }
    const title = String(msg.title ?? "").trim() || record.question;
    await manager.setSessionName(title, "user");
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
    safeStderr(`[btw] promoted topic ${recordId} to session ${newId.slice(0, 8)}\n`);
  },
};
