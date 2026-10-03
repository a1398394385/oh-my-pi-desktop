// Session lifecycle-domain frames: list/archive splitting, creation and activation, title sync,
// external writes, model and thinking level, rename/archive/stop/compact receipts, fork and
// entry-tree navigation. Moved over from store/ws.ts onMessage.
import { useAppStore } from "../index";
import { activateSession, clearBranchingMarks, activeOpen, updateSession } from "../session";
import { closeAllMenus } from "../../shell";
import { t } from "../../i18n";
import type { OpenSession } from "../../types/session";
import type { HandlerSlice } from "./types";

export const sessionHandlers = {
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
    const expandedProjects = new Set<string>(msg.expandedProjects ?? []);
    if (st2.isProjectManageMode) {
      for (const p of diskProjects) expandedProjects.add(p.cwd);
    }
    useAppStore.setState((s) => ({
      diskProjects,
      archivedSessions: archived,
      allProjects: msg.allProjects ?? [],
      removedProjects: msg.removedProjects ?? [],
      expandedProjects,
      pinnedSessions: new Set<string>(msg.pinnedSessions ?? []),
    }));
    const st3 = useAppStore.getState();
    const curSession = st3.activePath ? st3.openSessions.get(st3.activePath) : undefined;
    if (st3.activePath && !curSession?.isSubagent && !diskProjects.some((p) => p.sessions.some((r) => r.path === st3.activePath))) {
      useAppStore.setState((s) => {
        if (!s.activePath) return {};
        const openSessions = new Map(s.openSessions);
        openSessions.delete(s.activePath);
        return { openSessions, activePath: null };
      });
      useAppStore.getState().showWelcomeScreen(useAppStore.getState().newSessionProject || useAppStore.getState().getAvailableProjects()[0]?.cwd);
    }
  },
  session_created(msg) {
    useAppStore.setState((s) => ({
      openSessions: new Map(s.openSessions).set(msg.path, {
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        items: [],
        pendingApprovals: [],
        assistantDraft: "",
        streaming: false,
        turnStartAt: null,
        subagents: new Map(),
        model: msg.model ?? null,
        thinking: msg.thinking ?? "auto",
        isGit: !!msg.isGit,
        todos: [],
        goal: null, // goal state (set by the host goal frame; shown in the session status card's goal section)
        planMode: s.newSessionPlanMode, // seeded from the create intent; the host's plan_mode frame confirms right after
        title: msg.title ?? null,
        isSubagent: Boolean(msg.isSubagent),
        parentPath: msg.parentPath,
      } as OpenSession),
      isCreatingNew: false,
      newSessionPlanMode: false, // intent consumed by the created session
    }));
    // selectedFile/selectedSubagent are NOT pre-cleared here: activateSession → restoreRightPanel
    // owns them (fresh session without snapshot = cleared; reloaded session = snapshot restored;
    // clearing first would wipe the outgoing session's just-saved snapshot)
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
      if (s) {
        const imgPayload: Array<{ type: "image"; data: string; mimeType: string }> = (files ?? [])
          .filter((f) => f.kind === "image" && typeof f.data === "string")
          .map((f) => ({ type: "image", data: f.data as string, mimeType: f.mime || "image/png" }));
        updateSession(s.sessionId, (next) => {
          next.items.push({
            role: "user",
            text,
            ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
          });
          // Same as sendPrompt: set the running state on send (clock/stop button don't wait for the host's turn_start)
          next.streaming = true;
          next.turnStartAt = Date.now();
        });
        st3.ws!.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
        // Pin-to-bottom following is handled by the Chat component's scroll effect
      }
    }
    if (st3.pendingCreate) {
      useAppStore.setState({ pendingCreate: false });
      st3.send({ type: "list_sessions" }); // the new session has been persisted; refetch the list
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
    useAppStore.setState((st) => {
      let projectsChanged = false;
      const diskProjects = st.diskProjects.map((p) => {
        let sChanged = false;
        const sessions = p.sessions.map((r) => {
          if (r.id === msg.sessionId) {
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
        if (r.id === msg.sessionId) {
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
        s.externalWrite = true;
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
  session_aborted() {
    useAppStore.getState().toast(t("notify.generationStopped"));
  },
  session_compacted(msg) {
    useAppStore.getState().toast(msg.ok ? t("notify.contextCompacted") : (msg.error ?? t("notify.compactFailed")));
  },
  session_branched(msg) {
    // Fork receipt: clear the double-click guards (items mutated, empty patch swaps the reference to notify); the transcript is rebuilt from the messages frame pushed by load_session
    {
      const cur = activeOpen();
      if (cur) {
        clearBranchingMarks(cur.items);
        updateSession(cur.sessionId, () => {});
      }
    }
    if (!msg.ok) {
      useAppStore.getState().toast(msg.error ?? t("notify.forkFailed"));
      return;
    }
    useAppStore.getState().toast(t("notify.forked"));
    if (msg.selectedText) useAppStore.getState().setComposerValue(msg.selectedText, msg.selectedImages, { guard: true });
    useAppStore.getState().send({ type: "load_session", path: msg.newPath }); // reuse the on-disk session loading path
    useAppStore.getState().send({ type: "list_sessions" });
  },
  session_tree(msg) {
    useAppStore.setState((s) => ({
      rightState: {
        ...s.rightState,
        sessionTree: { sessionId: msg.sessionId ?? s.rightState.treeFor, branches: msg.branches ?? [] },
        sessionTreePending: false,
      },
    }));
  },
  entry_tree(msg) {
    useAppStore.setState((s) => ({
      rightState: {
        ...s.rightState,
        entryTree: { sessionId: msg.sessionId ?? s.rightState.entryTreeFor, leafId: msg.leafId ?? null, roots: msg.roots ?? [] },
        entryTreePending: false,
      },
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
      rightState: { ...s.rightState, entryTreeNav: false, navFrom: null, entryTree: msg.ok ? null : s.rightState.entryTree },
    }));
    if (!msg.ok) {
      useAppStore.getState().toast(msg.error ?? t("notify.navigateFailed"));
      return;
    }
    useAppStore.getState().toast(t("notify.navigated"));
    useAppStore.setState({ mainViewMode: "chat" });
    if (msg.editorText) useAppStore.getState().setComposerValue(msg.editorText, msg.editorImages, { guard: true });
  },
  capabilities(msg) {
    useAppStore.setState({ capabilities: msg.snapshot, capabilitiesFor: msg.snapshot.sessionId, capabilitiesLoading: false });
  },
  capabilities_mcp(msg) {
    // MCP runtime is process-global: apply to whatever snapshot is held, regardless of which session's attach pushed the frame
    useAppStore.setState((s) => (s.capabilities ? { capabilities: { ...s.capabilities, mcp: msg.mcp } } : {}));
  },
 } satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type SessionFrames = keyof typeof sessionHandlers;
