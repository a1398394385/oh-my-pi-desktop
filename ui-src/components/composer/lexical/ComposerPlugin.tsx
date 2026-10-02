// Lexical integration plugin for the Composer (mounted inside LexicalComposer):
//  · Keyboard commands: Enter sends / Ctrl+↵ steers (yielding to
//    TypeaheadMenuPlugin's LOW-priority handling while the completion panel is
//    open -- same as the old "Enter in completion state = accept candidate"),
//    Ctrl+Q queues, Alt+↑ recalls queued messages; semantics aligned line by
//    line with the old textarea onKeyDown; IME commit-Enter guard lives in this
//    plugin (core only covers composition in progress, which misses WebKit
//    ordering where compositionend arrives before the confirming keydown -- see
//    IME_COMMIT_ENTER_WINDOW_MS);
//  · Esc: swallow RichTextPlugin's default editor.blur() (still yields to the
//    typeahead menu to close itself) so focus stays in the input and Esc only
//    drives the global route (double-Esc clear / abort / open tree) -- matches
//    the old textarea behavior;
//  · Paste forced to plain text (insertRawText), keeping rich-text styles out
//    (aligned with textarea behavior);
//  · updateListener: syncs the module-level draft (EditorState snapshot +
//    flattened plain text); on text change, notifies the outer layer to refresh
//    (send button ready state / bash-mode class, equivalent to the old notify in
//    onInput);
//  · Handles (focus / setText / clear) exposed to Composer via handleRef,
//    replacing the old taRef operations.
import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref, RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $createParagraphNode,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_ARROW_UP_COMMAND,
  PASTE_COMMAND,
  FORMAT_TEXT_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  mergeRegister,
} from "lexical";
import type { PasteCommandType } from "lexical";
import { useAppStore } from "../../../store";
import { editQueueMsg } from "../../../store/session";
import { $flattenText, $setText } from "./flat";
import { saveDraft, getDraftText } from "./draft";

// Enter key-swallow window for IME candidate confirmation (ms): on WebKit,
// compositionend and the following Enter keydown land in nearly the same tick;
// the window only covers the dispatch misordering during that span, kept small
// to avoid swallowing a "real Enter pressed after mouse-selecting a candidate"
// by mistake
const IME_COMMIT_ENTER_WINDOW_MS = 100;

export type ComposerHandle = {
  focus(): void;
  setText(text: string): void;
  clear(): void;
};

type Props = {
  draftKey: string;
  handleRef: Ref<ComposerHandle>;
  onTextChange: (text: string) => void;
  sendPrompt: (steer: boolean) => void;
  // Completion panel open/close (maintained by TypeaheadMenuPlugin's
  // onOpen/onClose; Composer passes in the same ref): Enter / Alt+↑ yield while
  // the panel is open, avoiding fights with candidate navigation/acceptance
  typeaheadOpenRef: RefObject<boolean>;
};

export default function ComposerPlugin({ draftKey, handleRef, onTextChange, sendPrompt, typeaheadOpenRef }: Props) {
  const [editor] = useLexicalComposerContext();
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  // Callbacks take the latest closure via refs (sendPrompt is rebuilt every
  // render; listeners register only once)
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const sendPromptRef = useRef(sendPrompt);
  sendPromptRef.current = sendPrompt;
  // Timestamp of the most recent compositionend (0 = none). Safari/WebKit (the
  // WKWebView of Tauri on macOS) dispatches compositionend first when a
  // candidate is confirmed, then the keydown of that Enter; isComposing is
  // already false on the event, so Lexical core's isComposing guard cannot stop
  // it -> the confirmation Enter gets treated as a send. Recording the moment
  // adds this guard at the plugin layer (same-countermeasure as ProseMirror
  // 0c54477). Non-Apple platforms dispatch in the reverse order; it stays 0 and
  // never fires.
  const imeCommitAtRef = useRef(0);

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => editor.focus(),
      setText: (text: string) => editor.update(() => $setText(text)),
      clear: () =>
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        }),
    }),
    [editor],
  );

  useEffect(() => {
    // compositionstart/end are dispatched before the root element mounts (the
    // editor mounts later inside Composer), hence registerRootListener: attach
    // native listeners to the post-mount root element, without conflicting
    // with Lexical's own re-entrancy guard.
    return editor.registerRootListener((root) => {
      if (!root) return;
      const onEnd = (e: CompositionEvent) => {
        imeCommitAtRef.current = e.timeStamp;
      };
      const onStart = () => {
        imeCommitAtRef.current = 0;
      };
      root.addEventListener("compositionend", onEnd);
      root.addEventListener("compositionstart", onStart);
      return () => {
        root.removeEventListener("compositionend", onEnd);
        root.removeEventListener("compositionstart", onStart);
      };
    });
  }, [editor]);

  useEffect(
    () =>
      mergeRegister(
        // Enter: panel open -> yield (Typeahead LOW accepts the candidate);
        // ⇧↵ -> let the default insert a line break; otherwise send.
        // Ctrl+↵ steers (no alt/meta modifiers); ⌥↵/⌘↵ send normally (the old
        // Enter branch had no modifier exclusion either).
        // Dispatches with a null ev only occur on Lexical's composition teardown
        // path (composition text ending with \n); let the default insert a line
        // break -- never send on composition's coattails, aligned with the old
        // textarea era where the IME Enter did not send.
        // An unmodified Enter within the imeCommitAt window = IME candidate
        // confirmation; swallow it, do not send; swallow only once -- the next
        // real Enter after confirmation sends as usual.
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (ev) => {
            if (typeaheadOpenRef.current) return false;
            if (!ev || ev.shiftKey) return false;
            const imeCommitAt = imeCommitAtRef.current;
            if (imeCommitAt !== 0 && ev.timeStamp - imeCommitAt < IME_COMMIT_ENTER_WINDOW_MS) {
              imeCommitAtRef.current = 0;
              ev.preventDefault();
              ev.stopPropagation();
              return true;
            }
            ev.preventDefault();
            ev.stopPropagation();
            sendPromptRef.current(!!(ev.ctrlKey && !ev.altKey && !ev.metaKey));
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Esc: RichTextPlugin binds editor.blur() at EDITOR priority; one Esc
        // in the composer leaks focus out, and typing again requires a mouse
        // click back -- the global Esc routing (double-press clear / abort
        // generation / summon tree) does not depend on focus, so intercept it
        // here before the blur and keep focus in the input. Yield to
        // TypeaheadMenuPlugin closing the panel while it is open.
        // No preventDefault: keydown keeps bubbling to the document-level global
        // routing (all Esc semantics live there).
        editor.registerCommand(
          KEY_ESCAPE_COMMAND,
          () => !typeaheadOpenRef.current,
          COMMAND_PRIORITY_NORMAL,
        ),
        // Alt+↑: recall a queued message (last sent, first recalled) -- the
        // steer queue first, the follow-up queue if empty; yield while the panel
        // is open (candidate navigation); do not intercept the default behavior
        // with no session / both queues empty
        editor.registerCommand(
          KEY_ARROW_UP_COMMAND,
          (ev) => {
            if (typeaheadOpenRef.current) return false;
            if (!ev || !ev.altKey || ev.ctrlKey || ev.metaKey) return false;
            const st = useAppStore.getState();
            const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
            if (!s) return false;
            const steers = s.items.filter((it) => it.role === "user" && it.pending === "steer");
            const target = steers[steers.length - 1];
            const q = target ? undefined : s.queued?.[(s.queued?.length ?? 0) - 1];
            if (!target && !q) return false;
            ev.preventDefault();
            if (target) editQueueMsg(s, target);
            else editQueueMsg(s, { role: "user", text: q?.text || "", pending: "queued" });
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Ctrl+Q: enqueue as follow-up (also available while the panel is open;
        // the old palette interception block did not include q)
        editor.registerCommand(
          KEY_DOWN_COMMAND,
          (ev) => {
            if (ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === "q" || ev.key === "Q")) {
              ev.preventDefault();
              sendPromptRef.current(false);
              return true;
            }
            return false;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Paste takes plain text only (\n becomes a LineBreakNode via
        // insertRawText, inverse of the flattening rules)
        editor.registerCommand(
          PASTE_COMMAND,
          (ev: PasteCommandType) => {
            ev.preventDefault();
            const text = ev instanceof ClipboardEvent ? ev.clipboardData?.getData("text/plain") : undefined;
            if (text) editor.update(() => $getSelection()?.insertRawText(text));
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Swallow rich-text format commands (Ctrl+B/I/U etc.): plain-text
        // composer, consistent with the old textarea
        editor.registerCommand(
          FORMAT_TEXT_COMMAND,
          () => true,
          COMMAND_PRIORITY_NORMAL,
        ),
        // Draft sync: save the EditorState snapshot (restored on mount slot
        // switches) and the flattened text on every update; notify the outer
        // layer only when the text changes (send button state etc.);
        // selection-only updates do not trigger a re-render
        editor.registerUpdateListener(() => {
          const text = editor.read(() => $flattenText());
          const key = draftKeyRef.current;
          const changed = text !== getDraftText(key);
          saveDraft(key, editor.getEditorState(), text);
          if (changed) onTextChangeRef.current(text);
        }),
      ),
    [editor, typeaheadOpenRef],
  );

  return null;
}
