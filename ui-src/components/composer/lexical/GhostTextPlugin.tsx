// Ghost inline-completion plugin (contract v1 complete_text RPC, mounted
// inside LexicalComposer after ComposerPlugin):
//  · Trigger: 200ms typing pause with non-empty text and the caret at the end
//    of the text (inline completions only make sense while appending) -> send
//    { type:"complete_text", sessionId, text } over the store's WS.
//  · Reply: the host's `completion { sessionId, suggestion }` frame lands in
//    the store as completionResult; this plugin subscribes, drops stale or
//    empty replies silently (no error surface), and appends a GhostNode
//    (visual-only decorator) after the caret.
//  · Accept: Tab replaces the ghost with real text nodes (newline handling
//    mirrors flat.ts $setText); that update is a plain undoable edit -- the
//    following unguarded update listener re-arms the debounce, so accepted
//    completions chain into the next request naturally.
//  · Discard: any other update (typing, caret move, paste, external backfill)
//    or blur removes the ghost.
//  · IME: compositionstart cancels the pending request timer and drops the
//    ghost, and no request fires while composing. This plugin never
//    intercepts Enter, so the WebKit compositionend-before-Enter quirk (see
//    ComposerPlugin's IME_COMMIT_ENTER_WINDOW_MS) cannot leak a confirmation
//    keystroke into the ghost path.
//  · Ghost insert/remove updates run with { tag:"historic", discrete:true }:
//    excluded from the undo stack and committed synchronously, so the own-
//    update guard (applyingRef) reliably brackets the update listeners.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createLineBreakNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  KEY_TAB_COMMAND,
} from "lexical";
import type { LexicalNode } from "lexical";
import { useAppStore } from "../../../store";
import type { CompletionResult } from "../../../store/session";
import { $flattenText, $flattenWithCaret } from "./flat";
import { $createGhostNode, $findGhostNode } from "./GhostNode";
import { isBashMode } from "../trigger";

// Typing pause before a completion request fires (input settled)
const REQUEST_DEBOUNCE_MS = 200;

type Props = {
  // Completion panel open state (the same ref Composer passes to
  // ComposerPlugin): no requests while the sigil palette rides the same text
  typeaheadOpenRef: RefObject<boolean>;
};

export default function GhostTextPlugin({ typeaheadOpenRef }: Props) {
  const [editor] = useLexicalComposerContext();
  // Guards own ghost insert/remove updates against the universal "any
  // unguarded update dismisses the ghost" rule; discrete:true commits
  // synchronously so the flag reliably brackets the listeners it masks
  const applyingRef = useRef(false);
  const composingRef = useRef(false);
  // window.setTimeout returns a plain number under the DOM lib the UI builds
  // against (node's Timeout type leaks in via the dev dependency tree)
  const timerRef = useRef<number | null>(null);
  const lastTextRef = useRef<string | null>(null);
  // The request a reply must match (text + session) to be applied
  const lastReqRef = useRef<{ sessionId: string; text: string } | null>(null);

  useEffect(() => {
    // Set on cleanup: post-unmount deferred dismissals must not touch the
    // destroyed editor
    let disposed = false;
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // Own-update-bracketed ghost mutation: historic (never undoable on its
    // own) + synchronous commit
    const ghostUpdate = (fn: () => void) => {
      applyingRef.current = true;
      try {
        editor.update(fn, { tag: "historic", discrete: true });
      } finally {
        applyingRef.current = false;
      }
    };

    // Drop the ghost if present (no-op update when none exists)
    const dismissGhost = () => {
      if (disposed) return;
      if (!editor.read(() => $findGhostNode())) return;
      ghostUpdate(() => {
        $findGhostNode()?.remove();
      });
    };

    // ---- Completion request (debounced on text change) ----
    const requestCompletion = () => {
      const { text, caret } = editor.read(() => $flattenWithCaret());
      lastTextRef.current = text;
      // ! bash mode: no prose ghost over a shell command line (the bash
      // completion card owns that domain)
      if (!text.trim() || caret !== text.length || composingRef.current || typeaheadOpenRef.current || isBashMode(text)) {
        lastReqRef.current = null;
        return;
      }
      const st = useAppStore.getState();
      const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
      if (!s?.sessionId) {
        lastReqRef.current = null; // welcome slot / session not loaded yet
        return;
      }
      lastReqRef.current = { sessionId: s.sessionId, text };
      st.send({ type: "complete_text", sessionId: s.sessionId, text });
    };

    // ---- Reply application: staleness-checked insert of the ghost ----
    const applyCompletion = (res: CompletionResult) => {
      const req = lastReqRef.current;
      if (!req || res.sessionId !== req.sessionId) return; // not ours / session switched
      if (!res.suggestion) {
        lastReqRef.current = null; // engine off / superseded: silent close
        return;
      }
      // Staleness: the draft must be byte-identical to the request and the
      // caret still appending at its end; anything else drops the reply
      const { text, caret } = editor.read(() => $flattenWithCaret());
      if (text !== req.text || caret !== text.length || composingRef.current) return;
      ghostUpdate(() => {
        if ($findGhostNode()) return; // a reply is already rendered
        const last = $getRoot().getLastChild();
        if (!$isElementNode(last)) return;
        // Append after the last block child: the caret-at-end invariant makes
        // that exactly "behind the caret"; selection stays untouched
        last.append($createGhostNode(res.suggestion));
      });
    };

    // Drafts restored via initialConfig.editorState may carry a stale ghost
    // (the snapshot persists it as-is); strip it before first paint
    dismissGhost();

    const unsubStore = useAppStore.subscribe((st, prev) => {
      if (st.completionResult !== prev.completionResult && st.completionResult) {
        applyCompletion(st.completionResult);
      }
    });

    const unregisterUpdates = editor.registerUpdateListener(() => {
      if (applyingRef.current) return;
      const text = editor.read(() => $flattenText());
      if (text !== lastTextRef.current) {
        clearTimer();
        timerRef.current = window.setTimeout(requestCompletion, REQUEST_DEBOUNCE_MS);
      }
      // Any user-driven update (edit, caret move, backfill) kills the ghost;
      // removal is an editor.update, which must NOT run inside the commit's
      // read-only context (Lexical commits inside its own microtask cycle --
      // a queued microtask can still land mid-flush and get deferred with a
      // warning) -- hop to the next macrotask instead
      setTimeout(dismissGhost, 0);
    });

    // compositionstart/end can fire before the root element mounts (same
    // ordering caveat as ComposerPlugin): native listeners on the live root
    const removeRootListener = editor.registerRootListener((root) => {
      root?.addEventListener("compositionstart", onCompositionStart);
      root?.addEventListener("compositionend", onCompositionEnd);
    });
    function onCompositionStart() {
      composingRef.current = true;
      clearTimer(); // never request mid-composition
      dismissGhost();
    }
    function onCompositionEnd() {
      // The IME commit lands as a normal text update right after; that update
      // re-arms the debounce, so nothing else to do here
      composingRef.current = false;
    }

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        clearTimer();
        dismissGhost();
        return false; // no preventDefault: focus routing stays untouched
      },
      COMMAND_PRIORITY_NORMAL,
    );

    // ---- Tab accepts the ghost ----
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (ev) => {
        if (typeaheadOpenRef.current) return false; // palette Tab accepts a candidate
        const suggestion = editor.read(() => $findGhostNode())?.__suggestion;
        if (suggestion === undefined) return false;
        ev.preventDefault();
        // Deliberately a plain undoable update (no tag/discrete/guard): the
        // ghost removal rides along, and the unguarded listener afterwards
        // sees the text change and re-arms the debounce for the next request
        editor.update(() => {
          const ghost = $findGhostNode();
          if (!ghost) return;
          const parent = ghost.getParentOrThrow();
          const idx = ghost.getIndexWithinParent();
          ghost.remove();
          // Rebuild as real nodes with the same line-break rules as $setText
          const nodes: LexicalNode[] = [];
          suggestion.split("\n").forEach((line, i) => {
            if (i > 0) nodes.push($createLineBreakNode());
            if (line) nodes.push($createTextNode(line));
          });
          if (nodes.length > 0) parent.splice(idx, 0, nodes);
          const sel = $createRangeSelection();
          sel.anchor.set(parent.getKey(), idx + nodes.length, "element");
          sel.focus.set(parent.getKey(), idx + nodes.length, "element");
          $setSelection(sel);
        });
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );

    return () => {
      disposed = true;
      clearTimer();
      unsubStore();
      unregisterUpdates();
      removeRootListener();
      unregisterBlur();
      unregisterTab();
    };
  }, [editor, typeaheadOpenRef]);

  return null;
}
