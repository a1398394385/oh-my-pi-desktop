// Session and project list domain RPCs: create/load/delete/archive/rename/
// compact/branch/tree navigation, plus project list add/remove/reorder.
// Relocated from the message dispatch in main.ts (third cut).
import fs from "node:fs";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { SessionManager, USER_INTERRUPT_LABEL, AgentRegistry } from "../bootstrap.ts";
import { H, sessions, stampEvent, defaultWorkspaceDir } from "../state.ts";
import { readRemoteWorkspaceInfo } from "../remote-workspaces.ts";
import { saveDesktopProjects, mergeHistoryProjects } from "../profile.ts";
import { entriesToTranscript, treeToDisplay, sumRunDurationMs } from "../translate.ts";
import { applyActivityTimes } from "../session-activity.ts";
import {
  handleCreateSession,
  handleLoadSession,
  keepaliveStatusPayload,
  sessionPathFromDisk,
  copySessionArtifactsIfAny,
  createSessionCore,
  attachEntry,
} from "../session-lifecycle.ts";
import { releaseMcpForSession } from "../mcp-mount.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";
import { safeStderr } from "../stderr.ts";

export async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // All project directories, pinned first
  // mtime tracks non-activity writes (session_exit frames); use the last message time instead
  await applyActivityTimes(all);
  // Canonical grouping: the same directory reached through different spellings
  // (case, separators, symlink/junction vs real path — the 2026-10 mklink
  // incident) is ONE project row. Key = realpath+case-normalized path; the
  // spelling shown to the UI is picked per group below. normalizePathForComparison
  // hits the filesystem per distinct spelling, so cache within this call.
  const normCache = new Map<string, string>();
  const norm = (p: string) => {
    let k = normCache.get(p);
    if (k === undefined) normCache.set(p, (k = normalizePathForComparison(p)));
    return k;
  };
  // Row shape consumed by the frame mapping below (disk SessionInfo plus the
  // synthetic pool-fallback entries).
  interface ListedSession {
    id: string;
    path: string;
    title?: string | null;
    firstMessage?: string;
    modified: Date;
    messageCount?: number;
    cwd?: string;
  }
  const NO_CWD_KEY = "\0nocwd"; // sentinel: sessions without a cwd never merge into a real project
  const groups = new Map<string, ListedSession[]>();
  for (const s of all) {
    const key = s.cwd ? norm(s.cwd) : NO_CWD_KEY;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
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
    if (listed.has(entry.path) || entry.isSubagent) continue;
    if (H.desktopProjects.removedProjects.includes(entry.cwd)) continue;
    const key = entry.cwd ? norm(entry.cwd) : NO_CWD_KEY;
    const list = groups.get(key) ?? [];
    list.push({
      id: sid,
      path: entry.path,
      title: entry.title, // Lazily created, unpersisted sessions fall back to memory here (including post-rename titles)
      firstMessage: "",
      modified: new Date(),
      messageCount: 0,
      cwd: entry.cwd,
    });
    groups.set(key, list);
    listed.add(entry.path);
  }
  // Display spelling per group: candidates = live allProjects entries first (the
  // frontend joins allProjects ↔ projects by exact cwd string, so those spellings
  // keep the expanded/removed/pinned lists matching), then the newest session
  // spellings still on disk. Self-canonical spellings (realpath(cwd) === cwd: true
  // casing, not a link) win over mangled variants; otherwise the first candidate.
  const pickDisplayCwd = (key: string, sorted: ListedSession[]): string => {
    const candidates: string[] = [];
    for (const p of H.desktopProjects.allProjects) {
      if (norm(p) === key && !H.desktopProjects.removedProjects.includes(p) && fs.existsSync(p)) candidates.push(p);
    }
    for (const s of sorted) {
      if (s.cwd && fs.existsSync(s.cwd) && !candidates.includes(s.cwd)) candidates.push(s.cwd);
    }
    for (const c of candidates) {
      try {
        if (fs.realpathSync(c) === c) return c;
      } catch {
        // unresolvable spelling (OS blocks traversal): keep it only as plain candidate
      }
    }
    return candidates[0] ?? sorted[0]?.cwd ?? "";
  };
  const projects = [...groups.entries()]
    .map(([key, list]) => {
      list.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      const cwd = pickDisplayCwd(key, list);
      // Remote SSH workspace stubs: mark the project row so the UI swaps the
      // folder icon for the cloud and shows host:path instead of the stub path
      const remote = readRemoteWorkspaceInfo(cwd);
      return {
        cwd,
        ...(remote ? { remote: true, remoteLabel: `${remote.host}:${remote.remotePath}` } : {}),
        sessions: list.map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: (s.firstMessage ?? "").slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
          archived: H.desktopProjects.archivedSessions.includes(s.path),
        })),
      };
    })
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  // History scan: merge newly seen projects into the all-projects list (reached both at startup and on UI reconnect)
  if (mergeHistoryProjects(projects.map((p) => p.cwd))) await saveDesktopProjects();
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
      // App-owned backing dir for "work without a project": the frontend renders
      // it as a fixed row and never registers it in allProjects.
      defaultWorkspace: defaultWorkspaceDir,
    }),
  );
}


// 18.5 background job rows for the bg_jobs frame: snapshot list (running +
// recent, already owner-scoped by the base) enriched per id with inspection
// data (command/cwd only exist on process-backed jobs; pids are live only
// while running). Deduped by id in case a row transitions between lists.
function bgJobsPayload(entry: { session: { getAsyncJobSnapshot?: () => any; inspectAsyncJob?: (id: string) => any } }) {
  const snapshot = entry.session.getAsyncJobSnapshot?.();
  if (!snapshot) return [];
  const rows = new Map<string, { id: string; status?: string }>();
  for (const job of [...(snapshot.running ?? []), ...(snapshot.recent ?? [])]) rows.set(job.id, job);
  return [...rows.values()].map((job) => {
    const inspected = entry.session.inspectAsyncJob?.(job.id);
    return {
      id: job.id,
      command: inspected?.command ?? null,
      cwd: inspected?.cwd ?? null,
      pids: Array.isArray(inspected?.pids) ? inspected.pids : [],
      exitCode: typeof inspected?.exitCode === "number" ? inspected.exitCode : null,
      running: job.status === "running",
    };
  });
}

/** Whether this pooled session still has live work: an in-flight turn (agent_start opened the
    active-duration window), undelivered queued messages, or running background jobs. Evicting
    (reload/delete) such a session orphans the running AgentSession — it keeps working and
    persisting headless while the rebuilt view shows an idle session. */
function sessionBusy(entry: {
  activeStartedAt: number | null;
  session: { queuedMessageCount?: number; getAsyncJobSnapshot?: () => any };
}): boolean {
  if (entry.activeStartedAt !== null) return true;
  if ((entry.session.queuedMessageCount ?? 0) > 0) return true;
  const jobs = entry.session.getAsyncJobSnapshot?.();
  return Array.isArray(jobs?.running) && jobs.running.length > 0;
}

/** Pool-entry path match that tolerates a session file moved by the SDK (persistence notice):
    the frontend keeps the path it was handed at open time, so previous locations must keep
    resolving to the live entry instead of forking a second session over the abandoned file. */
function sessionEntryMatchesPath(entry: { path: string; previousPaths?: string[] }, p: string): boolean {
  return entry.path === p || (entry.previousPaths?.includes(p) ?? false);
}
export const sessionHandlers: Record<string, RpcHandler> = {
  async create_session(ws, msg) {
    await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking, msg.planMode === true, msg.computerMode === true);
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
      if (sessionEntryMatchesPath(entry, p)) entry.keepaliveWanted = false;
    }
  },
  get_keepalive_status(ws, msg) {
    // Pure query for the context detail card: the entry's latest keepalive
    // snapshot (host/keepalive.ts reportState) + the global switch. enabled
    // follows the global switch but is forced false for sessions that never
    // got the extension injected (created before the switch went on, or the
    // plugin double-load guard skipped injection); unknown/off sessions
    // report the zeroed disabled shape instead of erroring, so the card can
    // poll blindly.
    const state = sessions.get(String(msg.sessionId ?? ""))?.keepaliveState;
    ws.send(JSON.stringify(keepaliveStatusPayload(String(msg.sessionId ?? ""), state)));
  },
  async reload_session(ws, msg) {
    // Force a rebuild from disk (the "reload" action on the external-write
    // notice bar): the pool-reuse branch only pushes the in-memory snapshot
    // and cannot see content written by external processes; release mode
    // matches delete_session (unsubscribe + leave the pool).
    //
    // A live session must never be evicted while work is in flight: the
    // orphaned AgentSession would keep running headless (events go nowhere,
    // the UI loses the in-progress state) and keep persisting entries whose
    // ids are unknown to the rebuilt manager — pollExternalWrites would then
    // blame "another process" for writes this host itself made. Refuse while
    // a turn / queued messages / background jobs are live; the notice bar
    // stays and the live view keeps streaming.
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    let rebuildPath = p;
    for (const [key, e] of sessions.entries()) {
      if (!sessionEntryMatchesPath(e, p)) continue;
      if (sessionBusy(e)) throw new Error(hostI18n.t("errors.session.reloadBusy"));
      // Rebuild from the entry's CURRENT file, not the (possibly stale) request
      // path: after an SDK persistence move the frontend still holds the old
      // path, and rebuilding that would fork a second live session over a dead
      // file while the real one keeps writing its new location.
      rebuildPath = e.path;
      releaseMcpForSession(key, e);
      e.unsubscribe();
      sessions.delete(key);
      // Full teardown, not just unsubscribe: a surviving session keeps its
      // cache-warmer/keepalive (which persists usage rows while idle) and any
      // straggler writers alive — the same false "external write" trigger this
      // reload exists to clear. dispose() is the sanctioned terminal path
      // (SIGTERM wind-down uses it); it appends one session_exit row, which
      // the rebuild below reads back like any other persisted row.
      try {
        await e.session.dispose();
      } catch (err) {
        safeStderr(`[host] reload_session 释放旧会话失败: ${err}\n`);
      }
    }
    await handleLoadSession(ws, rebuildPath);
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
        try { releaseMcpForSession(key, entry); } catch {}
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
      if (err?.code !== "ENOENT") safeStderr(`[host] 删除会话文件失败: ${err}\n`);
    }
    if (p.endsWith(".jsonl")) {
      const artifactsDir = p.slice(0, -6);
      try {
        await fs.promises.rm(artifactsDir, { recursive: true, force: true });
      } catch (err: any) {
        if (err?.code !== "ENOENT") safeStderr(`[host] 删除会话产物目录失败: ${err}\n`);
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
    // The app-owned "work without a project" backing dir is a fixed sidebar row,
    // not a registrable project: adding it would duplicate that row and let the
    // user remove it.
    if (cwd === defaultWorkspaceDir) throw new Error(hostI18n.t("errors.param.reservedProject"));
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
  async kill_subagent(_ws, msg) {
    // Agent Hub kill: abort one spawned subagent by its SDK id via the global
    // AgentRegistry (kept-alive agent refs live there regardless of the TUI).
    // Unknown/terminal ids (e.g. hist-* replays) resolve to nothing — no-op.
    const ref = AgentRegistry.global().get(String(msg.subagentId ?? ""));
    if (!ref?.session) return;
    await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
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
  async fork_session(ws, msg) {
    // 18.5 base fork, desktop semantics aligned with branch_session: the
    // source session stays pooled and untouched; the fork becomes an
    // independent pooled session and the frontend switches to it. Without
    // entryId, SessionManager.forkFrom copies ALL entries + artifacts into a
    // fresh file (the base's whole-session fork); with entryId the new file
    // holds the root→entry path inclusive (the base's entry fork via
    // createBranchedSession with artifact copy), and a user-message target's
    // text backfills the composer through selectedText.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    try {
      // An empty session has nothing to fork and no file on disk (lazy
      // persistence): refuse up front instead of letting forkFrom throw
      // ForkSourceNotFoundError on a never-written path
      if (entry.manager.getEntries().length === 0) {
        throw new Error(hostI18n.t("errors.session.emptyNoFork"));
      }
      // Ensure the source's latest state is persisted before copying
      await entry.manager.flush();
      const sourcePath = entry.path ?? (await sessionPathFromDisk(msg.sessionId));
      if (!sourcePath) throw new Error(hostI18n.t("errors.session.cannotLocateSource"));
      const entryId = msg.entryId === undefined || msg.entryId === null ? "" : String(msg.entryId);
      let newSessionFile: string | undefined;
      let selectedText: string | null = null;
      if (entryId) {
        const tempManager = await SessionManager.open(sourcePath);
        const targetEntry = tempManager.getEntry(entryId);
        if (!targetEntry) throw new Error(hostI18n.t("errors.session.entryNotFound", { entryId }));
        // Inclusive cut, artifacts copied by the base (unlike branch_session,
        // no step-back to the parent for user messages — the native fork
        // keeps the target entry itself)
        newSessionFile = tempManager.createBranchedSession(entryId, { copyArtifacts: true });
        if (!newSessionFile) throw new Error(hostI18n.t("errors.session.forkCreateFailed"));
        if (targetEntry.type === "message" && targetEntry.message.role === "user") {
          selectedText =
            typeof targetEntry.message.content === "string"
              ? targetEntry.message.content
              : (targetEntry.message.content ?? [])
                  .filter((b: { type?: string }) => b?.type === "text")
                  .map((b: { text?: string }) => b.text ?? "")
                  .join("\n");
        }
      } else {
        const peek = await SessionManager.peekSessionInit(sourcePath);
        // repairInterruptedTail: a live (mid-turn) source can carry a dangling
        // tool call; the base's /tan fork pairs it with synthetic aborted
        // results so the fork's transcript stays well-formed
        const forked = await SessionManager.forkFrom(sourcePath, peek?.cwd ?? entry.cwd, undefined, undefined, {
          repairInterruptedTail: true,
        });
        newSessionFile = forked.getSessionFile();
        if (!newSessionFile) throw new Error(hostI18n.t("errors.session.forkCreateFailed"));
      }
      // Fresh manager on the new file, then a pooled session like branch_session
      const newManager = await SessionManager.open(newSessionFile);
      const newEntries = newManager.getEntries();
      const newTranscript = entriesToTranscript(newEntries);
      const newPeek = await SessionManager.peekSessionInit(newSessionFile);
      const workCwd = newPeek?.cwd ?? entry.cwd;
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
      ws.send(JSON.stringify({ type: "messages", sessionId: newSessionId, messages: newTranscript }));
      ws.send(
        JSON.stringify({
          type: "session_forked",
          sessionId: msg.sessionId,
          ok: true,
          newSessionId,
          newPath: newSessionFile,
          selectedText,
        }),
      );
      await handleListSessions(ws); // Sidebar project tree refresh, same as branch_session
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_forked", sessionId: msg.sessionId, ok: false, error: String(err) }));
    }
  },
  get_bg_jobs(ws, msg) {
    // 18.5 background job snapshot: the model's backgrounded bash/task/eval
    // rows (async job manager scoped to this session). Enriches the snapshot
    // list with per-job inspection (cwd / live pids / exit code) in one frame.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    ws.send(JSON.stringify(stampEvent({ type: "bg_jobs", sessionId: msg.sessionId, jobs: bgJobsPayload(entry) })));
  },
  cancel_bg_job(ws, msg) {
    // Cancel one running background job; unknown/foreign ids come back false
    // (no-op), then the refreshed snapshot goes out either way
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const jobId = String(msg.jobId ?? "");
    if (jobId) entry.session.cancelAsyncJob?.(jobId);
    ws.send(JSON.stringify(stampEvent({ type: "bg_jobs", sessionId: msg.sessionId, jobs: bgJobsPayload(entry) })));
  },
  async control_subagent(ws, msg) {
    // 18.4.9 subagent control: cancel aborts one running subagent (unknown /
    // finished ids are a no-op success), steer sends the host's text to it as
    // its user. Handlers come from the base's RPC layer; they resolve the
    // live ref through the session's RpcSubagentRegistry (created in
    // createSessionCore before any subagent can spawn). Dynamic import
    // because a static one would hoist the SDK graph above bootstrap's
    // setProfile (profile red line).
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const agentId = String(msg.agentId ?? "");
    if (!agentId) throw new Error(hostI18n.t("errors.param.missingSubagentId"));
    const action = msg.action === "cancel" || msg.action === "steer" ? msg.action : undefined;
    if (!action) throw new Error(hostI18n.t("errors.subagent.invalidAction", { action: String(msg.action) }));
    const registry = entry.subagentRegistry as { getSubagents: () => unknown[] } | undefined;
    if (!registry) throw new Error(hostI18n.t("errors.subagent.registryUnavailable"));
    const { handleRpcCancelSubagent, handleRpcSteerSubagent } = await import(
      "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode"
    );
    if (action === "cancel") {
      await handleRpcCancelSubagent(registry, agentId);
      ws.send(JSON.stringify(stampEvent({ type: "subagent_controlled", sessionId: msg.sessionId, agentId, ok: true })));
      return;
    }
    const text = String(msg.text ?? "");
    if (!text.trim()) throw new Error(hostI18n.t("errors.param.missingMessage"));
    const failure = await handleRpcSteerSubagent(registry, agentId, text);
    ws.send(
      JSON.stringify(
        stampEvent({
          type: "subagent_controlled",
          sessionId: msg.sessionId,
          agentId,
          ok: !failure,
          ...(failure ? { error: failure } : {}),
        }),
      ),
    );
  },
};
