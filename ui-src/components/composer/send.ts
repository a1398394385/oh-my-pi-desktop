// Composer send pipeline (sunk from components/Composer.tsx by A14): bash mode
// (! / !! prefix), the welcome page's deferred session creation (pendingNewBash /
// pendingNewPrompt intents consumed by the session_created handler), queue/steer
// optimistic updates, and the plain run start via the store's single run-start
// write (dispatchPrompt). Store-level module function (same style as the store
// slices' exported functions); no React. The component hands in the draft text
// and attachments and clears its editor state only when this returns true.
import { useAppStore } from "../../store";
import { bubbleImages, dispatchPrompt, updateSession } from "../../store/session";
import { takeAnnotations } from "../../store/annotations";
import { worktreeCreateSession } from "../../store/worktree";
import { buildQuotePrefix } from "../../lib/conversation-quote";
import { t } from "../../i18n";
import type { PromptAttachment } from "../../types/frames";
import { isBashMode } from "./trigger";

// create_session request for the welcome page's deferred creation: the pendingNew*
// intent was already stashed by the caller; the session_created handler consumes it.
function requestCreateSession(): void {
  const st = useAppStore.getState();
  st.send({
    type: "create_session",
    cwd: st.newSessionProject || undefined,
    model: st.newSessionModel || undefined,
    thinking: st.newSessionThinking || undefined,
    planMode: st.newSessionPlanMode || undefined,
    // null (untouched) stays undefined: the host then follows computer.defaultEnabled
    computerMode: st.newSessionComputerMode ?? undefined,
  });
  useAppStore.setState({ pendingCreate: true });
}

/** worktree_create_session failure codes that have their own copy (static keys:
 *  the i18n gate only allows registered dynamic prefixes). */
const WORKTREE_SESSION_CODES: Record<string, string> = {
  missing_base: "worktree.code.missing_base",
  not_a_repo: "worktree.code.not_a_repo",
  worktree_create_failed: "worktree.code.worktree_create_failed",
  start_ref_unresolvable: "worktree.code.start_ref_unresolvable",
  start_ref_missing_subdir: "worktree.code.start_ref_missing_subdir",
  worktree_root_tracked: "worktree.code.worktree_root_tracked",
};

/** worktree-toggle first send: create the managed copy, register its root, then run
 *  the regular deferred-creation pipeline (pendingNewPrompt + create_session)
 *  against the copy's cwd. The composer draft was already cleared when the send
 *  was accepted, so a failure restores it via the composer's backfill channel;
 *  the toggle stays on so a retry is one click. */
async function createSessionInWorktree(text: string, files: PromptAttachment[]): Promise<void> {
  const fail = (code: string | undefined, detail: string | undefined) => {
    const st = useAppStore.getState();
    const key = (code && WORKTREE_SESSION_CODES[code]) || "worktree.code.worktree_create_failed";
    st.toast(t(key, { defaultValue: detail || t("worktree.create.failed") }));
    // Backfill the text + image attachments through the composer's own channel;
    // path/text attachments re-enter the pendingFiles chip row directly.
    const images = files.filter((f) => f.kind === "image");
    const others = files.filter((f) => f.kind !== "image");
    st.setComposerValue(text, images.map((f) => ({ name: f.name, data: f.data, mimeType: f.mime })));
    if (others.length > 0) {
      useAppStore.setState((st2) => {
        let seq = st2.fileSeq;
        const restored = others.map((f) => ({ ...f, id: ++seq }));
        return { pendingFiles: [...st2.pendingFiles, ...restored], fileSeq: seq };
      });
    }
  };
  try {
    const baseCwd = useAppStore.getState().newSessionProject;
    const reply = await worktreeCreateSession(baseCwd);
    if (!reply.ok || !reply.path || !reply.cwd) {
      fail(reply.code, reply.error);
      return;
    }
    // Register the copy ROOT (not a mirrored subdir cwd): sidebar repo groups
    // only merge registered dirs, so without this the session would not land
    // under its repository row (managed-worktree-spec, frontend orchestration).
    useAppStore.getState().send({ type: "add_project", cwd: reply.path });
    useAppStore.setState({ newSessionProject: reply.cwd, newSessionWorktree: false });
    useAppStore.setState({ pendingNewPrompt: { text, files } });
    requestCreateSession();
  } catch (err) {
    fail(undefined, err instanceof Error ? err.message : String(err));
  } finally {
    useAppStore.setState({ worktreeSessionCreating: false });
  }
}

/** Dispatch the composer draft. Returns true when something was sent or an intent
 *  was stashed (the caller clears the draft editor only then). `raw` keeps leading
 *  whitespace: bash-mode detection requires `!` as the very first character. */
export function sendComposerPrompt(input: { raw: string; files: PromptAttachment[]; steer?: boolean }): boolean {
  const st = useAppStore.getState();
  const text = input.raw.trim();
  const ws = st.ws;
  if (!ws || ws.readyState !== 1) return false;
  const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;

  // Subagent sessions do not support slash or terminal commands
  if (s?.isSubagent && (text.startsWith("/") || isBashMode(input.raw))) {
    st.toast(t("chat.subagentSlashNotSupported"));
    return false;
  }

  // bash mode (! as the first character, !! = result kept out of model
  // context): executed locally, no user bubble; the row is created by the
  // bash_start frame (aligned with the TUI input-controller send routing)
  if (isBashMode(input.raw)) {
    const excludeFromContext = input.raw.startsWith("!!");
    const command = excludeFromContext ? input.raw.slice(2).trim() : input.raw.slice(1).trim();
    if (!command) return false; // `!` / `!!` with empty command: no action (same as TUI)
    // Welcome page (no session yet): auto-create one like a first message,
    // then execute after the session_created receipt
    if (st.isCreatingNew || !s) {
      useAppStore.setState({ pendingNewBash: { command, excludeFromContext } });
      requestCreateSession();
      return true;
    }
    st.send({ type: "bash_exec", sessionId: s.sessionId, command, excludeFromContext });
    return true;
  }

  // Selection annotations ride as a text prefix (host unchanged); slash commands are
  // consumed locally, so they never take the block and pending notes stay for the next
  // real prompt. The full text is what the host stores and echoes back (queue/steer
  // matching), so every display surface strips the block (lib/conversation-quote).
  const notes = text.startsWith("/") ? [] : takeAnnotations();
  const prompt = notes.length > 0 ? buildQuotePrefix(notes) + text : text;
  // Notes are prompt content: a comment-only send is valid, an empty one is not.
  if (!prompt && input.files.length === 0) return false;

  // Creating-new state: store the draft in pendingNewPrompt; the store sends it
  // after the session_created receipt
  if (st.isCreatingNew || !s) {
    // Worktree toggle: the first send creates the managed copy and only then
    // continues the regular create_session flow with the copy's cwd. The toggle
    // is hidden for non-git projects, so newSessionIsGit is the same gate the
    // visibility rule applies.
    if (st.newSessionWorktree && st.newSessionIsGit && st.newSessionProject) {
      if (st.worktreeSessionCreating) return false; // one copy per intent: a repeat send during creation is a no-op
      useAppStore.setState({ worktreeSessionCreating: true });
      void createSessionInWorktree(prompt, input.files);
      return true;
    }
    useAppStore.setState({ pendingNewPrompt: { text: prompt, files: input.files } });
    requestCreateSession();
    return true;
  }

  // Sending while streaming = enqueue as followUp (auto-consumed when the
  // current loop finishes); Ctrl+↵ is steer -- immediate injection (after the
  // current tool batch), the bubble is pinned at the bottom of the message
  // flow, and the split happens at consumption time (steer_consumed)
  // updateSession swaps the session/Map reference: both selector-subscribed
  // components (Composer / QueueCard) and the old useStore components see it
  if (s.streaming) {
    updateSession(s.sessionId, (next) => {
      if (input.steer) {
        next.steering = next.steering ?? [];
        next.steering.push({ text: prompt });
        next.items.push({
          role: "user",
          text: prompt,
          pending: "steer",
          ...(bubbleImagesOf(input.files)),
        });
      } else {
        next.queued = next.queued ?? [];
        next.queued.push({ text: prompt, ...bubbleImagesOf(input.files) });
      }
    });
    // The wire dispatch was dropped when the old Composer pipeline sank into
    // this module (A14): the optimistic queue/steer updates above were left
    // with no matching prompt RPC, so mid-stream messages never reached the
    // host — the steer bubble ended up sealed into the runEnd loop group with
    // no steer_consumed ever coming (the vanished-message bug). The base
    // routes by its own streaming state: queued while streaming, a plain new
    // turn when the run already ended.
    st.send({ type: "prompt", sessionId: s.sessionId, text: prompt, files: input.files, ...(input.steer ? { steer: true } : {}) });
  } else {
    // Single optimistic run-start write (startLocalRun) + prompt dispatch
    dispatchPrompt(s.sessionId, prompt, input.files, input.steer);
  }
  // Sidebar time = user-message time: stamp the list row now (steer/queued sends count
  // too); the runEnd session_list refresh later carries the authoritative end time.
  // Match by path (activePath = this session's file path): the pool sessionId is a
  // per-open UUID and never equals the list row's disk session id
  st.bumpSessionActivity(st.activePath!);
  // Pin-to-bottom following is handled by Chat's scroll effect
  return true;
}

// Image payload spread for the optimistic steer bubble (undefined when the
// attachments carry no usable images, so no empty images field lands)
function bubbleImagesOf(files: PromptAttachment[]) {
  const images = bubbleImages(files);
  return images && images.length > 0 ? { images } : {};
}
