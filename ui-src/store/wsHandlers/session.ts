// Session lifecycle-domain frames: list/archive splitting, creation and activation, title sync,
// external writes, model and thinking level, rename/archive/stop/compact receipts, fork and
// entry-tree navigation. Moved over from store/ws.ts onMessage.
import { useAppStore } from "../index";
import { REMOTE } from "../ws";
import { activateSession, clearBranchingMarks, activeOpen, dispatchPrompt, landPoolSessions, settleAbortedRunLater, updateSession } from "../session";
import { pathOfSessionId } from "../session-lookup";
import { pushInputHistory } from "../../components/composer/lexical/draft";
import { closeAllMenus } from "../../shell";
import { t } from "../../i18n";
import type { OpenSession, SubagentState } from "../../types/session";
import { disposeRightSlot } from "../right";
import type { HandlerSlice } from "./types";

// Shared receipt for the two copy-style fork flows (session_branched from
// branch_session, session_forked from fork_session). Clear the double-click
// guards (items mutated, empty patch swaps the reference to notify), backfill
// the cut entry's text, then load the new pooled session from disk — the
// transcript itself is rebuilt from the messages frame the host pushes ahead
// of this receipt.
// Verified divergence (was: branched passed msg.selectedImages, forked hard
// undefined): the host never puts selectedImages on either frame
// (host/rpc/session.ts branch_session/fork_session send selectedText only), so
// both paths always backfilled with images undefined. Backfill stays
// text-only here; adding images to the wire is the A10 contract pass.
function applyForkReceipt(msg: { ok: boolean; error?: string; newPath?: string; selectedText?: string | null }) {
  const cur = activeOpen();
  if (cur) {
    clearBranchingMarks(cur.items);
    updateSession(cur.sessionId, () => {});
  }
  if (!msg.ok) {
    useAppStore.getState().toast(msg.error ?? t("notify.forkFailed"));
    return;
  }
  useAppStore.getState().toast(t("notify.forked"));
  if (msg.selectedText) useAppStore.getState().setComposerValue(msg.selectedText, undefined, { guard: true });
  useAppStore.getState().send({ type: "load_session", path: msg.newPath }); // reuse the on-disk session loading path
  useAppStore.getState().send({ type: "list_sessions" });
}

export const sessionHandlers = {
  pool_sessions(msg) {
    // Host pool residency snapshot (attach / release / list refresh): the sidebar's "active tasks"
    // list renders it. Full-replace — the frame is the whole pool, never a delta.
    landPoolSessions(msg.sessions);
  },
  session_list(msg) {
    // Split out archived entries: they don't go into diskProjects; stored separately as archivedSessions for the sidebar archive area
    const st2 = useAppStore.getState();
    const archived: typeof st2.archivedSessions = [];
    const diskProjects: typeof st2.diskProjects = [];
    for (const p of msg.projects) {
      const sessions = [];
      for (const r of p.sessions) {
        if (r.archived) archived.push({ ...r, cwd: p.cwd });
        else sessions.push(r);
      }
      diskProjects.push({ ...p, sessions });
    }
    archived.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    // Remote (phone) clients keep expansion client-local: REMOTE mode never sends
    // set_project_expanded (ProjectsSlice, spec §4.3), so re-adopting the host value on every
    // list frame would revert each tap and force a second tap. The host value seeds only the
    // first frame, where the client has no expansion state of its own yet.
    const expandedProjects =
      REMOTE && st2.diskProjects.length > 0
        ? new Set<string>(st2.expandedProjects)
        : new Set<string>(msg.expandedProjects ?? []);
    if (st2.isProjectManageMode) {
      for (const p of diskProjects) expandedProjects.add(p.cwd);
    }
    useAppStore.setState((s) => ({
      diskProjects,
      archivedSessions: archived,
      allProjects: msg.allProjects ?? [],
      gitProjects: new Set(msg.gitProjects ?? []),
      removedProjects: msg.removedProjects ?? [],
      defaultWorkspace: msg.defaultWorkspace ?? "",
      expandedProjects,
      pinnedSessions: new Set(msg.pinnedSessions ?? []),
      // First frame lands = host is up and the project list is real: drop the
      // boot veil (idempotent on later frames; the project reconciliation
      // below swaps the "/" placeholder in the same commit cycle).
      bootSplash: false,
    }));
    const st3 = useAppStore.getState();
    const curSession = st3.activePath ? st3.openSessions.get(st3.activePath) : undefined;
    if (st3.activePath && !curSession?.isSubagent && !diskProjects.some((p) => p.sessions.some((r) => r.path === st3.activePath))) {
      // Active session vanished from disk: destroy its slot (host resources — terminal
      // PTY — die with it) before the panel leaves it. showWelcomeScreen then restores
      // the welcome pseudo-slot; its own save is skipped (activePath already null).
      disposeRightSlot(st3.activePath);
      useAppStore.setState((s) => {
        if (!s.activePath) return {};
        const openSessions = new Map(s.openSessions);
        openSessions.delete(s.activePath);
        return { openSessions, activePath: null };
      });
      useAppStore.getState().showWelcomeScreen(useAppStore.getState().newSessionProject || useAppStore.getState().getAvailableProjects()[0]?.cwd);
    }
    // Startup reconciliation: the welcome page mounts before this frame lands, so its
    // project briefly falls back to the "/" placeholder (no disk list yet); once the real
    // list arrives (default workspace pinned first), swap any invalid pick back to the
    // default row. A valid pick (including one the user just chose) is left untouched.
    const st4 = useAppStore.getState();
    const avail = st4.getAvailableProjects();
    if (st4.isCreatingNew && avail.length > 0 && !avail.some((p) => p.cwd === st4.newSessionProject)) {
      st4.setWelcomeProject(avail[0].cwd);
    }
  },
  session_text_search(msg) {
    // Sidebar full-text hits (search_session_text). Frames carry the query they answered,
    // so a slow reply for a keyword the user already replaced lands harmless — SidebarSearch
    // only reads hits whose query equals the current input.
    useAppStore.setState({ sessionTextSearch: { query: String(msg.query ?? ""), hits: msg.hits ?? [] } });
  },
  session_unloaded(msg) {
    // Pool eviction receipt (session_unload): drop the frontend slot the same
    // way the "active session vanished from disk" reconciliation does — the
    // evicted session's row stays in the sidebar (disk file untouched) and
    // clicking it again re-enters the pool via load_session.
    const path = String(msg.path ?? "");
    if (!path) return;
    // Row-level notice instead of a bottom toast: the sidebar row swaps the "session closed"
    // notice in over its title for 1s (SessionRow carousel). Runs before the slot guard below —
    // the host may evict a session this client never had a frontend slot for.
    useAppStore.setState((s) => ({ unloadedPaths: new Set(s.unloadedPaths).add(path) }));
    setTimeout(() => {
      useAppStore.setState((s) => {
        const next = new Set(s.unloadedPaths);
        next.delete(path);
        return { unloadedPaths: next };
      });
    }, 1000);
    const st = useAppStore.getState();
    if (!st.openSessions.has(path)) return;
    if (st.activePath === path) {
      disposeRightSlot(path);
      useAppStore.setState((s) => {
        const openSessions = new Map(s.openSessions);
        openSessions.delete(path);
        return { openSessions, activePath: null };
      });
      useAppStore.getState().showWelcomeScreen(useAppStore.getState().newSessionProject || useAppStore.getState().getAvailableProjects()[0]?.cwd);
    } else {
      useAppStore.setState((s) => {
        const openSessions = new Map(s.openSessions);
        openSessions.delete(path);
        return { openSessions };
      });
    }
  },

  session_finished(msg) {
    // Host broadcast at terminal run end, aimed at channels that never attached the
    // session (attached ones already handled their turn_end): light the sidebar's
    // unread dot locally and refresh the list (title/preview/modified changed). The
    // dot is per-device by design — each channel's own "haven't seen it" state.
    const path = String(msg.path ?? "");
    if (!path) return;
    const st = useAppStore.getState();
    const attached = [...st.openSessions.values()].some((s) => s.sessionId === msg.sessionId);
    if (!attached) st.send({ type: "list_sessions" }); // attached channels refresh from their own turn_end
    if (path !== st.activePath) {
      useAppStore.setState((s) => ({ unseenFinished: new Set(s.unseenFinished).add(path) }));
      useAppStore.getState().saveUnseen();
    }
  },
  session_created(msg) {
    // Scheduler-spawned (automation) session: register the slot so its live event frames
    // render without a reload, but stay in the background — no focus steal, the automations
    // view stays open, and no welcome-page intents are consumed.
    if (msg.automation) {
      useAppStore.setState((s) => ({
        openSessions: new Map(s.openSessions).set(msg.path, {
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          items: [],
          pendingApprovals: [],
          assistantDraft: "",
          streaming: Boolean(msg.busy), // automation runs stream on creation; the spinner shows without waiting for a frame
          turnStartAt: msg.busySince ?? null,
          subagents: new Map(),
          model: msg.model ?? null,
          thinking: msg.thinking ?? "auto",
          isGit: !!msg.isGit,
          todos: [],
          goal: null,
          planMode: false,
          computerMode: false,
          title: msg.title ?? null,
          isSubagent: false,
          automation: msg.automation,
          connEpoch: s.connEpoch,
        } as OpenSession),
      }));
      return;
    }
    useAppStore.setState((s) => {
      // A child session opened mid-run must show the spinner + elapsed row immediately: a
      // subagent inside a long tool call emits no progress events, so the frame-driven
      // lighting (syncSubViewStream) would leave the view dark for the whole tool run.
      // Seeded by transcript path (the host's parentPath is not a store key).
      let live: SubagentState | undefined;
      for (const o of s.openSessions.values()) {
        for (const sub of o.subagents.values()) {
          // Non-terminal status = still running (lifecycle says "started", the progress
          // heartbeat overwrites it with "running")
          const done = sub.status === "completed" || sub.status === "failed" || sub.status === "aborted";
          if (!done && sub.sessionFile === msg.path) {
            live = sub;
            break;
          }
        }
        if (live) break;
      }
      return {
        openSessions: new Map(s.openSessions).set(msg.path, {
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          items: [],
          pendingApprovals: [],
          assistantDraft: "",
          // Subagent seed (live) or mid-run open of a session another channel is
          // running (host busy flag): either way the view must spin immediately —
          // frame-driven lighting alone stays dark through long tool calls
          streaming: Boolean(live || msg.busy),
          // Subagent view: its own registration time. Main session opened mid-run by the
          // other channel: the host's run start, so the "Working Ns" clock matches both ends
          // instead of counting from this channel's attach (or the next turn_start).
          turnStartAt: live?.registeredAt ?? msg.busySince ?? null,
          subagents: new Map(),
          model: msg.model ?? null,
          thinking: msg.thinking ?? "auto",
          isGit: !!msg.isGit,
          todos: [],
          goal: null, // goal state (set by the host goal frame; shown in the session status card's goal section)
          planMode: s.newSessionPlanMode, // seeded from the create intent; the host's plan_mode frame confirms right after
          computerMode: s.newSessionComputerMode, // seeded from the create intent; the host's computer_mode frame confirms right after
          title: msg.title ?? null,
          isSubagent: Boolean(msg.isSubagent),
          parentPath: msg.parentPath,
          connEpoch: s.connEpoch,
        } as OpenSession),
        isCreatingNew: false,
        automationsOpen: false, // any session taking over the main column closes the tasks view
        newSessionPlanMode: false, // intent consumed by the created session
        newSessionComputerMode: false, // intent consumed by the created session
      };
    });
    // selectedFile/selectedSubagent are NOT pre-cleared here: activateSession → restoreRightSlot
    // owns them (fresh session without slot = cleared; reloaded session = slot restored;
    // clearing first would wipe the outgoing session's just-saved slot)
    activateSession(msg.path);
    useAppStore.getState().refreshGitDiff(); // the right-panel Git Diff page needs git status data; prefetch early
    const st3 = useAppStore.getState();
    if (st3.pendingOpenHub) {
      const sel = st3.pendingHubSel;
      useAppStore.setState({ pendingOpenHub: false, pendingHubSel: null });
      useAppStore.getState().openHub();
      if (sel) useAppStore.getState().setHubSel(sel);
    }
    if (st3.pendingNewPrompt) {
      const { text, files } = st3.pendingNewPrompt;
      useAppStore.setState({ pendingNewPrompt: null });
      const s = st3.openSessions.get(st3.activePath ?? "");
      // Single run-start write + prompt dispatch, identical to the composer send path
      if (s) dispatchPrompt(s.sessionId, text, files);
      // The deferred first prompt joins the created session's input history
      // (its slot did not exist at send time; composer.recallClearedDrafts
      // gates it the same way as the in-session send path)
      if (useAppStore.getState().hostSettings?.values?.["composer.recallClearedDrafts"] !== false) {
        pushInputHistory(msg.path, { text, files });
      }
    }
    if (st3.pendingNewBash) {
      const { command, excludeFromContext } = st3.pendingNewBash;
      useAppStore.setState({ pendingNewBash: null });
      const s = st3.openSessions.get(st3.activePath ?? "");
      // The bash_start frame creates the row; no optimistic bubble needed
      if (s) st3.send({ type: "bash_exec", sessionId: s.sessionId, command, excludeFromContext });
      // Same input-history treatment, restoring the raw !/!! prefix
      if (useAppStore.getState().hostSettings?.values?.["composer.recallClearedDrafts"] !== false) {
        pushInputHistory(msg.path, { text: (excludeFromContext ? "!!" : "!") + command, files: [] });
      }
    }
    // The welcome page's model / thinking pick is the intent for the session that
    // create_session just produced — consumed here like planMode / computerMode,
    // so it never leaks into the NEXT new-session page. pendingCreate (already
    // cleared below) is the marker: the host also pushes session_created for plain
    // loads / plan-approve swaps, which carry no welcome-page intent. Clear the
    // manual-pick mark first, then force re-seed the profile config default.
    const fromWelcome = st3.pendingCreate;
    if (st3.pendingCreate) {
      useAppStore.setState({ pendingCreate: false });
      st3.send({ type: "list_sessions" }); // the new session has been persisted; refetch the list
    }
    if (fromWelcome) {
      useAppStore.setState({ newSessionDirty: false }); // silent write (force init below notifies on its own)
      useAppStore.getState().initNewSessionModel(true);
    }
  },
  session_title_changed(msg) {
    // 1. Update the title of the matching opened session (the currently active session updates too if it is this one)
    updateSession(
      msg.sessionId,
      (s) => {
        s.title = msg.title;
      },
      false,
    );
    // 2. Update the session's title in the on-disk project list (keeps titles referenced by the sidebar in sync)
    // Disk rows carry the disk session id while this frame carries the pool UUID, and the two never
    // coincide (host session-lifecycle.ts): match by path. The frame carries the entry path so a
    // channel that never attached the session (remote watching the desktop and vice versa) has
    // nothing to resolve; the open slot is only a fallback for a frame without it.
    const livePath = msg.path ?? pathOfSessionId(msg.sessionId, useAppStore.getState().openSessions);
    useAppStore.setState((st) => {
      let projectsChanged = false;
      const diskProjects = st.diskProjects.map((p) => {
        let sChanged = false;
        const sessions = p.sessions.map((r) => {
          if (r.id === msg.sessionId || (livePath !== undefined && r.path === livePath)) {
            sChanged = true;
            projectsChanged = true;
            return { ...r, title: msg.title };
          }
          return r;
        });
        return sChanged ? { ...p, sessions } : p;
      });

      let archivedChanged = false;
      const archivedSessions = st.archivedSessions.map((r) => {
        if (r.id === msg.sessionId || (livePath !== undefined && r.path === livePath)) {
          archivedChanged = true;
          return { ...r, title: msg.title };
        }
        return r;
      });

      const patch: Partial<typeof st> = {};
      if (projectsChanged) patch.diskProjects = diskProjects;
      if (archivedChanged) patch.archivedSessions = archivedSessions;
      return patch;
    });
  },
  // The host detected an external process writing to this session (CLI chat/rename): set the
  // notice strip until reload. If the session was evicted by the frontend LRU the frame is
  // dropped; on switch-back through the pool-reuse branch the host re-sends based on
  // entry.externalWrite
  session_external_write(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.externalWrite = msg.clear !== true;
      },
      false,
    );
  },
  session_model(msg) {
    updateSession(msg.sessionId, (s) => {
      s.model = msg.model;
      if (msg.thinking) s.thinking = msg.thinking;
    });
  },
  session_thinking(msg) {
    updateSession(msg.sessionId, (s) => {
      s.thinking = msg.level;
    });
  },
  // Quick-switch receipt (ctrl+p role cycle): ok=false = fewer than two
  // resolvable roles — surface the CLI's status line message as a toast and
  // collapse the preview menu (its optimistic open assumed a cyclable list)
  cycle_model(msg) {
    if (!msg.ok) {
      useAppStore.getState().toast(t("composer.onlyOneRoleModel"));
      if (useAppStore.getState().cyclePreview) {
        useAppStore.setState({ cyclePreview: null });
        closeAllMenus();
      }
      return;
    }
    updateSession(msg.sessionId, (s) => {
      if (msg.model) s.model = msg.model;
      if (msg.thinking) s.thinking = msg.thinking;
    });
    // Authoritative correction of the preview highlight (the local prediction
    // can diverge when several roles resolve to the same model)
    const st = useAppStore.getState();
    if (st.cyclePreview && msg.model) {
      useAppStore.setState({ cyclePreview: { ...st.cyclePreview, activeRole: msg.role ?? st.cyclePreview.activeRole, activeModel: msg.model } });
    }
  },
  session_renamed(msg) {
    if (msg.ok) {
      useAppStore.getState().toast(t("notify.renamed"));
      useAppStore.getState().send({ type: "list_sessions" }); // the host is the sole source of truth for list data; refetching is the safest
    } else {
      // The frame shape has no error field (ok is always true; the failure path is a defensive fallback only); the assertion just supplies the type, runtime reads unchanged
      const renamedErr = msg as { error?: string };
      useAppStore.getState().toast(renamedErr.error ?? t("notify.renameFailed"));
    }
  },
  session_archived(msg) {
    if (msg.ok) {
      useAppStore.getState().toast(t(msg.archived ? "notify.archived" : "notify.unarchived"));
      useAppStore.getState().send({ type: "list_sessions" });
    } else {
      const archivedErr = msg as { error?: string }; // same as above: defensive fallback only
      useAppStore.getState().toast(archivedErr.error ?? t("notify.archiveFailed"));
    }
  },
  session_aborted(msg) {
    useAppStore.getState().toast(t("notify.generationStopped"));
    settleAbortedRunLater(msg.sessionId);
  },
  session_compacted(msg) {
    useAppStore.getState().toast(msg.ok ? t("notify.contextCompacted") : (msg.error ?? t("notify.compactFailed")));
  },
  session_branched(msg) {
    // branch_session receipt, same switch flow as session_forked
    applyForkReceipt(msg);
  },
  session_forked(msg) {
    // 18.5 base fork (fork_session) receipt, same switch flow as session_branched
    applyForkReceipt(msg);
  },
  entry_tree(msg) {
    useAppStore.setState((s) => ({
      entryTree: { sessionId: msg.sessionId ?? s.entryTreeFor, leafId: msg.leafId ?? null, roots: msg.roots ?? [] },
      entryTreePending: false,
    }));
  },
  session_navigated(msg) {
    // In-tree navigation receipt: the transcript is rebuilt from the messages frame; on success the
    // entry tree is invalidated and refetched (the abandoned path became a sibling branch, the old
    // tree structure is stale), and the original user message is backfilled into the composer (to re-ask)
    {
      const cur = activeOpen();
      if (cur) {
        clearBranchingMarks(cur.items);
        updateSession(cur.sessionId, () => {});
      }
    }
    useAppStore.setState((s) => ({
      entryTreeNav: false, navFrom: null, entryTree: msg.ok ? null : s.entryTree,
    }));
    if (!msg.ok) {
      useAppStore.getState().toast(msg.error ?? t("notify.navigateFailed"));
      return;
    }
    useAppStore.getState().toast(t("notify.navigated"));
    useAppStore.setState({ mainViewMode: "chat" });
    if (msg.editorText) useAppStore.getState().setComposerValue(msg.editorText, msg.editorImages, { guard: true });
  },
  session_edited(msg) {
    // Edit-resend receipt: both outcomes consume the send-time stash
    // (pendingEditText, set by the UserMsg edit box) and invalidate the entry
    // tree like session_navigated on success — ok forked a sibling branch, a
    // failure can still land after a partial navigate; the tree page refetches
    // lazily on next render. Success keeps no store state (the sending
    // component already collapsed its edit box); failure restores the stashed
    // text/images into the composer so the edit is never silently lost (same
    // backfill as editQueueMsg).
    useAppStore.setState({ entryTree: null });
    const stash = useAppStore.getState().pendingEditText;
    useAppStore.setState({ pendingEditText: null });
    if (msg.ok) return;
    if (stash && stash.sessionId === msg.sessionId) useAppStore.getState().setComposerValue(stash.text, stash.images);
    useAppStore.getState().toast(t("chat.editResendFailed", { error: msg.error ?? t("notify.navigateFailed") }), true);
  },
  // Cache-warming runtime snapshot (get_keepalive_status reply / reportState push): ringpop
  // popover transient alongside ctxDetail/ctxLimits, but stored per session — the ring's
  // center count must survive switching back to a session that stopped reporting
  keepalive_status(msg) {
    useAppStore.setState((s) => ({ keepaliveStatus: { ...s.keepaliveStatus, [msg.sessionId]: msg } }));
  },
 } satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type SessionFrames = keyof typeof sessionHandlers;
