// Composer send pipeline (sunk from components/Composer.tsx by A14): bash mode
// (! / !! prefix), the welcome page's deferred session creation (pendingNewBash /
// pendingNewPrompt intents consumed by the session_created handler), queue/steer
// optimistic updates, and the plain run start via the store's single run-start
// write (dispatchPrompt). Store-level module function (same style as the store
// slices' exported functions); no React. The component hands in the draft text
// and attachments and clears its editor state only when this returns true.
import { useAppStore } from "../../store";
import { bubbleImages, dispatchPrompt, updateSession } from "../../store/session";
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
    computerMode: st.newSessionComputerMode || undefined,
  });
  useAppStore.setState({ pendingCreate: true });
}

/** Dispatch the composer draft. Returns true when something was sent or an intent
 *  was stashed (the caller clears the draft editor only then). `raw` keeps leading
 *  whitespace: bash-mode detection requires `!` as the very first character. */
export function sendComposerPrompt(input: { raw: string; files: PromptAttachment[]; steer?: boolean }): boolean {
  const st = useAppStore.getState();
  const text = input.raw.trim();
  const ws = st.ws;
  if ((!text && input.files.length === 0) || !ws || ws.readyState !== 1) return false;
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

  // Creating-new state: store the draft in pendingNewPrompt; the store sends it
  // after the session_created receipt
  if (st.isCreatingNew || !s) {
    useAppStore.setState({ pendingNewPrompt: { text, files: input.files } });
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
        next.steering.push({ text });
        next.items.push({
          role: "user",
          text,
          pending: "steer",
          ...(bubbleImagesOf(input.files)),
        });
      } else {
        next.queued = next.queued ?? [];
        next.queued.push({ text });
      }
    });
  } else {
    // Single optimistic run-start write (startLocalRun) + prompt dispatch
    dispatchPrompt(s.sessionId, text, input.files, input.steer);
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
