// Module-level composer drafts (isolated per session / welcome page):
// the EditorState snapshot serves mount restoration (initialConfig.editorState);
// text is the flattened plain text (read by send / hasDraft / bash prefix
// detection). The only writer is ComposerPlugin's updateListener.
import type { EditorState } from "lexical";
import type { PromptAttachment } from "../../../types/frames";

export type PendingFile = PromptAttachment & { id: number };

export interface SessionDraft {
  state: EditorState | null;
  text: string;
  files: PendingFile[];
}

const drafts = new Map<string, SessionDraft>();

export function getDraft(key = "welcome"): SessionDraft {
  let d = drafts.get(key);
  if (!d) {
    d = { state: null, text: "", files: [] };
    drafts.set(key, d);
  }
  return d;
}

export function getDraftState(key = "welcome"): EditorState | null {
  return drafts.get(key)?.state ?? null;
}

export function getDraftText(key = "welcome"): string {
  return drafts.get(key)?.text ?? "";
}

export function getDraftFiles(key = "welcome"): PendingFile[] {
  return drafts.get(key)?.files ?? [];
}

export function saveDraft(key: string, nextState: EditorState, nextText: string): void {
  const d = getDraft(key || "welcome");
  d.state = nextState;
  d.text = nextText;
}

export function saveDraftFiles(key: string, files: PendingFile[]): void {
  const d = getDraft(key || "welcome");
  d.files = files;
}

export function clearDraftState(key: string): void {
  drafts.delete(key || "welcome");
}

// contentEditable support probe: in environments like happy-dom the
// contentEditable attribute is readable but Lexical's runtime dependencies are
// missing (MutationObserver etc. -- mounting throws ReferenceError immediately)
// -- initialize Lexical only when both hold; otherwise the Composer degrades to
// a read-only placeholder and related operations all no-op (the smoke
// environment takes this branch).
const probe = (() => {
  try {
    if (typeof MutationObserver === "undefined") return false;
    const d = document.createElement("div");
    d.contentEditable = "true";
    d.style.display = "none";
    document.body.appendChild(d);
    const ok = d.isContentEditable === true;
    d.remove();
    return ok;
  } catch {
    return false;
  }
})();
export const CONTENT_EDITABLE_OK: boolean = probe;
