// Session and project list domain RPCs: create/load/delete/archive/rename/
// compact/branch/tree navigation, plus project list add/remove/reorder.
// Relocated from the message dispatch in main.ts (third cut).
import fs from "node:fs";
import { SessionManager, USER_INTERRUPT_LABEL } from "../bootstrap.ts";
import { H, sessions } from "../state.ts";
import { saveDesktopProjects, mergeHistoryProjects } from "../profile.ts";
import { entriesToTranscript, treeToDisplay, sumRunDurationMs } from "../translate.ts";
import { applyActivityTimes } from "../session-activity.ts";
import {
  handleCreateSession,
  handleLoadSession,
  sessionPathFromDisk,
  copySessionArtifactsIfAny,
  createSessionCore,
  attachEntry,
} from "../session-lifecycle.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

export async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // All project directories, pinned first
  // mtime tracks non-activity writes (session_exit frames); use the last message time instead
  await applyActivityTimes(all);
  const byProject = new Map<string, any[]>();
  for (const s of all) {
    const list = byProject.get(s.cwd) ?? [];
    list.push(s);
    byProject.set(s.cwd, list);
  }
  // In-memory pool fallback: the base lazily creates session files (persisted
  // on the first content), so a disk-only scan misses freshly created
  // sessions with no content yet — the UI's "active session missing from the
  // list bounces back to the welcome page" check would wrongly kill those new
  // sessions. Projects the user removed are skipped: an active session must
  // not push a removed project back into the list (otherwise remove never
  // takes effect).
  const listed = new Set(all.map((s: any) => s.path));
  for (const [sid, entry] of sessions.entries()) {
    if (listed.has(entry.path)) continue;
    if (H.desktopProjects.removedProjects.includes(entry.cwd)) continue;
    const list = byProject.get(entry.cwd) ?? [];
    list.push({
      id: sid,
      path: entry.path,
      title: entry.title, // Lazily created, unpersisted sessions fall back to memory here (including post-rename titles)
      firstMessage: "",
      modified: new Date(),
      messageCount: 0,
      cwd: entry.cwd,
    });
    byProject.set(entry.cwd, list);
    listed.add(entry.path);
  }
  // History scan: merge newly seen projects into the all-projects list (reached both at startup and on UI reconnect)
  if (mergeHistoryProjects([...byProject.keys()])) await saveDesktopProjects();
  const projects = [...byProject.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: s.firstMessage.slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
          archived: H.desktopProjects.archivedSessions.includes(s.path),
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
    }),
  );
}

export const sessionHandlers: Record<string, RpcHandler> = {
  async create_session(ws, msg) {
    await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking);
  },
  async load_session(ws, msg) {
    await handleLoadSession(ws, msg.path);
  },
  mark_seen(ws, msg) {
    // Notified when the frontend switches to a session (activateSession/
    // openSessionByPath): seen = stop cache keepalive probing. Switching
    // between already-open sessions on the frontend does not send
    // load_session, so this method is the only way to reach the host
    const p = String(msg.path ?? "").trim();
    if (!p) return;
    for (const entry of sessions.values()) {
      if (entry.path === p) entry.keepaliveWanted = false;
    }
  },
  async reload_session(ws, msg) {
    // Force a rebuild from disk (the "reload" action on the external-write
    // notice bar): the pool-reuse branch only pushes the in-memory snapshot
    // and cannot see content written by external processes; release mode
    // matches delete_session (unsubscribe + leave the pool)
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    for (const [key, e] of sessions.entries()) {
      if (e.path !== p) continue;
      e.unsubscribe();
      sessions.delete(key);
    }
    await handleLoadSession(ws, p);
  },
  async list_sessions(ws) {
    await handleListSessions(ws);
  },
  async remove_project(ws, msg) {
    // Remove from the project list (sessions stay in history; the "recent" view still shows them)
    const cwd = String(msg.cwd ?? "").trim();
    if (!cwd) throw new Error(hostI18n.t("errors.param.missingCwd"));
    if (!H.desktopProjects.removedProjects.includes(cwd)) H.desktopProjects.removedProjects.push(cwd);
    await saveDesktopProjects();
    await handleListSessions(ws);
  },
  async delete_session(ws, msg) {
    // Permanently delete a session (physical file + its artifacts dir + in-memory pool entry and pin records)
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    for (const [key, entry] of sessions.entries()) {
      if (entry.path === p) {
        try { entry.unsubscribe(); } catch {}
        sessions.delete(key);
      }
    }
    const pi = H.desktopProjects.pinnedSessions.indexOf(p);
    if (pi >= 0) {
      H.desktopProjects.pinnedSessions.splice(pi, 1);
      await saveDesktopProjects();
    }
    // Archive records are cleaned up along with the session
    const ai = H.desktopProjects.archivedSessions.indexOf(p);
    if (ai >= 0) {
      H.desktopProjects.archivedSessions.splice(ai, 1);
      await saveDesktopProjects();
    }
    try {
      await fs.promises.unlink(p);
    } catch (err: any) {
      if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话文件失败: ${err}\n`);
    }
    if (p.endsWith(".jsonl")) {
      const artifactsDir = p.slice(0, -6);
      try {
        await fs.promises.rm(artifactsDir, { recursive: true, force: true });
      } catch (err: any) {
        if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话产物目录失败: ${err}\n`);
      }
    }
    await handleListSessions(ws);
  },
  async set_project_expanded(_ws, msg) {
    // Project expansion persistence: recorded in omp-desktop.json expandedProjects; unrecorded ones default to collapsed
    const cwd = String(msg.cwd ?? "").trim();
    const on = !!msg.expanded;
    if (!cwd) throw new Error(hostI18n.t("errors.param.missingCwd"));
    const i = H.desktopProjects.expandedProjects.indexOf(cwd);
    if (on && i < 0) H.desktopProjects.expandedProjects.push(cwd);
    if (!on && i >= 0) H.desktopProjects.expandedProjects.splice(i, 1);
    await saveDesktopProjects();
  },
  async set_session_pinned(_ws, msg) {
    // Pinned session persistence: recorded in omp-desktop.json pinnedSessions, survives restarts
    const p = String(msg.path ?? "").trim();
    const on = !!msg.pinned;
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    const i = H.desktopProjects.pinnedSessions.indexOf(p);
    if (on && i < 0) H.desktopProjects.pinnedSessions.push(p);
    if (!on && i >= 0) H.desktopProjects.pinnedSessions.splice(i, 1);
    await saveDesktopProjects();
  },
  async archive_session(ws, msg) {
    // Archive persistence: recorded by session file path in omp-desktop.json
    // archivedSessions (same key shape as pinnedSessions, cleaned up in sync
    // by delete_session); archiving also unpins. Unopened history sessions
    // (not in the in-memory pool) resolve their path from disk by the base's
    // session id and can be archived too.
    const on = !!msg.archived;
    const entry = sessions.get(msg.sessionId);
    const p = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
    const ai = H.desktopProjects.archivedSessions.indexOf(p);
    if (on && ai < 0) H.desktopProjects.archivedSessions.push(p);
    if (!on && ai >= 0) H.desktopProjects.archivedSessions.splice(ai, 1);
    if (on) {
      const pi = H.desktopProjects.pinnedSessions.indexOf(p);
      if (pi >= 0) H.desktopProjects.pinnedSessions.splice(pi, 1);
    }
    await saveDesktopProjects();
    ws.send(JSON.stringify({ type: "session_archived", sessionId: msg.sessionId, ok: true, archived: on }));
  },
  async add_project(ws, msg) {
    // Manual add: if it hits the removed list, move it back to all projects; otherwise merge it in as a new project (pinned to the top, immediately visible)
    const cwd = String(msg.cwd ?? "").trim();
    if (!cwd) throw new Error(hostI18n.t("errors.param.missingCwd"));
    const ri = H.desktopProjects.removedProjects.indexOf(cwd);
    if (ri >= 0) H.desktopProjects.removedProjects.splice(ri, 1);
    if (!H.desktopProjects.allProjects.includes(cwd)) H.desktopProjects.allProjects.unshift(cwd);
    await saveDesktopProjects();
    await handleListSessions(ws);
  },
  async reorder_projects(_ws, msg) {
    // Drag reorder: the full order sent by the UI wins; existing items it does not cover (concurrent-change fallback) keep their order and append at the tail
    const order = Array.isArray(msg.order) ? msg.order.filter((x: unknown) => typeof x === "string") : [];
    if (order.length === 0) throw new Error(hostI18n.t("errors.param.missingOrder"));
    const set = new Set(order);
    const rest = H.desktopProjects.allProjects.filter((c) => !set.has(c));
    H.desktopProjects.allProjects = [...order, ...rest];
    await saveDesktopProjects();
  },
  async abort_session(ws, msg) {
    // Interrupt the in-flight generation: reason uses USER_INTERRUPT_LABEL so
    // the transcript can mark that round's assistant message as user-initiated;
    // aborting an idle session is equally safe (the base's waitForIdle returns
    // immediately). After the abort the base naturally reaches its
    // agent_end/turn events — no extra wind-down needed.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
    ws.send(JSON.stringify({ type: "session_aborted", sessionId: msg.sessionId, ok: true }));
  },
  async rename_session(ws, msg) {
    // Session rename: goes through the base's SessionManager.setSessionName
    // (source:"user") to persist (title slot + history.db title index), so
    // other entries like the CLI read the same title. Open sessions use the
    // pooled manager; unopened history sessions open the disk file and
    // persist the same way (title slot insertion/in-place update is handled
    // by the base). Lazily created unpersisted sessions only take effect in
    // memory, rendered via entry.title in the list_sessions fallback entry.
    const title = String(msg.title ?? "").trim();
    if (!title) throw new Error(hostI18n.t("errors.param.missingTitle"));
    const entry = sessions.get(msg.sessionId);
    if (entry) {
      if (!(await entry.manager.setSessionName(title, "user"))) {
        throw new Error(hostI18n.t("errors.session.invalidTitle"));
      }
      entry.title = title;
    } else {
      const manager = await SessionManager.open(await sessionPathFromDisk(msg.sessionId));
      if (!(await manager.setSessionName(title, "user"))) {
        throw new Error(hostI18n.t("errors.session.invalidTitle"));
      }
    }
    ws.send(JSON.stringify({ type: "session_renamed", sessionId: msg.sessionId, ok: true, title }));
  },
  async compact_session(ws, msg) {
    // Manual compact: the base's compact rewrites the session history (LLM
    // summary). Empty sessions fail fast up front (nothing to compact, saving
    // a pointless model call); when incompressible or compaction fails, the
    // base throws and the error field tells the frontend; on success the
    // transcript is rebuilt from disk entries and pushed, so the frontend
    // immediately swaps to the compacted view.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    if (entry.transcript.length === 0) {
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: hostI18n.t("errors.session.emptyNoCompact") }));
      return;
    }
    try {
      await entry.session.compact();
      entry.transcript = entriesToTranscript(entry.manager.getEntries());
      // The rebuilt history already contains mention rows: align the cursor to avoid re-sending them on later read-backs
      entry.mentionScanIndex = entry.manager.getEntries().length;
      ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, ok: true }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: String(err) }));
    }
  },
  async branch_session(ws, msg) {
    // Copy-style session fork: anchor at the specified entry, slice the
    // history chain, and produce an independent new session file
    // (header.parentSession points back to the source file). The source
    // session stays untouched in the host pool; the new session joins the
    // pool and the frontend is told to switch to it.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const entryId = String(msg.entryId ?? "");
    if (!entryId) throw new Error(hostI18n.t("errors.param.missingEntryId"));
    try {
      // Ensure the current session's latest data is persisted
      await entry.manager.flush();
      const parentPath = entry.path ?? (await sessionPathFromDisk(msg.sessionId));
      if (!parentPath) throw new Error(hostI18n.t("errors.session.cannotLocateSource"));

      // Open the parent session file with a separate SessionManager for the branch slice, avoiding pollution of the active entry.manager / entry.session
      const tempManager = await SessionManager.open(parentPath);
      const targetEntry = tempManager.getEntry(entryId);
      if (!targetEntry) throw new Error(hostI18n.t("errors.session.entryNotFound", { entryId }));

      const isUser = targetEntry.type === "message" && targetEntry.message.role === "user";
      // For a user-message fork (compat): the branch point is its parent node and the text is backfilled; for an assistant-message fork, that round's reply is kept in full
      const branchLeafId = isUser && targetEntry.parentId ? targetEntry.parentId : entryId;
      const newSessionFile = tempManager.createBranchedSession(branchLeafId);
      if (!newSessionFile) throw new Error(hostI18n.t("errors.session.forkCreateFailed"));

      // Copy the artifacts dir (if any)
      await copySessionArtifactsIfAny(parentPath, newSessionFile);

      // Create an independent AgentSession instance for the new session and add it to the sessions pool
      const newManager = await SessionManager.open(newSessionFile);
      const newEntries = newManager.getEntries();
      const newTranscript = entriesToTranscript(newEntries);
      const peek = await SessionManager.peekSessionInit(newSessionFile);
      const workCwd = peek?.cwd ?? entry.cwd;
      const { sessionId: newSessionId, entry: newEntry, eventBus: newBus } = await createSessionCore(
        workCwd,
        newManager,
        newTranscript,
        entry.session.model,
      );
      newEntry.mentionScanIndex = newEntries.length;
      newEntry.activeMs = sumRunDurationMs(newEntries);
      attachEntry(ws, newSessionId, newEntry, newBus);
      sessions.set(newSessionId, newEntry);

      // Extract the selected text (only user messages need it to backfill the composer; after forking an assistant reply the composer stays blank awaiting the question)
      const selectedText = isUser
        ? (typeof targetEntry.message.content === "string"
            ? targetEntry.message.content
            : (targetEntry.message.content ?? [])
                .filter((b: any) => b?.type === "text")
                .map((b: any) => b.text)
                .join("\n"))
        : null;

      // Push the new session's messages snapshot and the session_branched receipt
      ws.send(JSON.stringify({ type: "messages", sessionId: newSessionId, messages: newTranscript }));
      ws.send(
        JSON.stringify({
          type: "session_branched",
          sessionId: msg.sessionId,
          ok: true,
          newSessionId,
          newPath: newSessionFile,
          selectedText,
        }),
      );
      await handleListSessions(ws); // List refresh signal: the session_list frame tells the sidebar project tree to update
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_branched", sessionId: msg.sessionId, ok: false, error: String(err) }));
    }
  },
  async get_session_tree(ws, msg) {
    // Cross-file branch family: listAll scans the disk and links the graph by
    // header.parentSession (parent file path). Trace upward from the current
    // session file to the root, then collect all descendants downward from
    // the root; titles come from listAll's base-side resolution (same source
    // as list_sessions). Session not found (unpersisted and not pooled)
    // returns the error field.
    const entry = sessions.get(msg.sessionId);
    const curPath = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
    const all = await SessionManager.listAll();
    await applyActivityTimes(all);
    const byPath = new Map<string, any>(all.map((s: any) => [s.path, s]));
    const cur = byPath.get(curPath);
    if (!cur) {
      ws.send(JSON.stringify({ type: "session_tree", sessionId: msg.sessionId, ok: false, error: hostI18n.t("errors.session.fileNotOnDisk", { path: curPath }) }));
      return;
    }
    // Trace upward to the root (seenUp guards against cycles in dirty data)
    let root = cur;
    const seenUp = new Set<string>([curPath]);
    while (root.parentSessionPath && byPath.has(root.parentSessionPath) && !seenUp.has(root.parentSessionPath)) {
      root = byPath.get(root.parentSessionPath);
      seenUp.add(root.path);
    }
    // BFS from the root collecting the family (same depth ordered by mtime ascending, root first)
    const family: any[] = [];
    const visited = new Set<string>([root.path]);
    const queue = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      family.push(node);
      const children = all
        .filter((s: any) => s.parentSessionPath === node.path && !visited.has(s.path))
        .sort((a, b) => a.modified.getTime() - b.modified.getTime());
      for (const c of children) {
        visited.add(c.path);
        queue.push(c);
      }
    }
    ws.send(
      JSON.stringify({
        type: "session_tree",
        sessionId: msg.sessionId,
        ok: true,
        branches: family.map((s) => ({
          sessionId: s.id,
          path: s.path,
          title: s.title ?? null,
          modified: s.modified.toISOString(),
          parentSession: s.parentSessionPath ?? null,
          isCurrent: s.path === curPath,
          messageCount: s.messageCount,
        })),
      }),
    );
  },
  async get_entry_tree(ws, msg) {
    // In-session entry tree (same data source as the TUI's /tree):
    // manager.getTree() returns the entry forest inside the current file
    // (sibling branches left by rewind/fork coexist in one file),
    // getLeafId() marks the current leaf. This is a different tree from
    // get_session_tree (the cross-file family) — do not conflate them.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const leafId = entry.manager.getLeafId();
    ws.send(
      JSON.stringify({
        type: "entry_tree",
        sessionId: msg.sessionId,
        ok: true,
        leafId,
        roots: treeToDisplay(entry.manager.getTree(), leafId),
      }),
    );
  },
  async navigate_tree(ws, msg) {
    // In-tree navigation (a /tree node selection): the base's navigateTree
    // stays within the same file, moving the leaf to the target entry while
    // the abandoned path is kept as a sibling branch — unlike branch_session
    // (new file), the pool key/sessionId is unchanged. On success the
    // transcript is rebuilt compact-style and a messages frame is pushed;
    // editorText/editorImages are the target user message's original text,
    // for the frontend to backfill the composer (re-ask). Simplification:
    // allowAskReopen is not passed (the ask re-answer flow is TUI-interactive
    // only); an ask toolResult target takes the base's default plain leaf
    // move.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const entryId = String(msg.entryId ?? "");
    if (!entryId) throw new Error(hostI18n.t("errors.param.missingEntryId"));
    // Target is already the current leaf: the base's navigateTree returns
    // cancelled:false outright (neither erroring nor moving); a silent
    // "success" would make the fork button at the output tail look effective
    // while nothing changed — refuse explicitly here.
    if (entry.manager?.getLeafId() === entryId) {
      ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: hostI18n.t("errors.session.alreadyAtPosition") }));
      return;
    }
    try {
      const result = await entry.session.navigateTree(entryId, { summarize: !!msg.summarize });
      if (result.cancelled) {
        ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: hostI18n.t("errors.session.navigateCancelled") }));
        return;
      }
      if (result.aborted) {
        ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: hostI18n.t("errors.session.summaryAborted") }));
        return;
      }
      // getEntries() returns every entry in the file (abandoned branches are
      // still in there); the active transcript only wants the root→leaf path
      // — same scope as the base's renderInitialMessages
      entry.transcript = entriesToTranscript(entry.manager.getBranch());
      ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
      ws.send(
        JSON.stringify({
          type: "session_navigated",
          sessionId: msg.sessionId,
          ok: true,
          editorText: result.editorText ?? null,
          editorImages: result.editorImages ?? null,
        }),
      );
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: String(err) }));
    }
  },
};
