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

// Cleared-draft stash (per composer slot, module-level = gone at app exit):
// Ctrl+C / double-Esc clears push the draft here while the
// composer.recallClearedDrafts setting is on; Ctrl+↑/Ctrl+↓ walk it back into
// the composer. cursor -1 = the live draft (browsing base snapshot), 0..n-1 =
// stash entries oldest-to-newest.
export interface ClearedDraft {
  text: string;
  files: PendingFile[];
}
const clearedStash = new Map<string, { items: ClearedDraft[]; cursor: number; snapshot: ClearedDraft | null }>();

export function stashClearedDraft(key = "welcome"): void {
  const d = getDraft(key);
  if (!d.text.trim() && d.files.length === 0) return;
  const st = clearedStash.get(key) ?? { items: [], cursor: -1, snapshot: null };
  st.items.push({ text: d.text, files: [...d.files] });
  st.cursor = -1;
  st.snapshot = null;
  clearedStash.set(key, st);
}

// Move the browsing cursor one step (dir 1 = older, -1 = newer) and return the
// draft to show; null = stash empty. cursor -1 = the live draft (pre-browsing
// snapshot, possibly empty), 0 = newest stash entry, n-1 = oldest.
export function recallClearedDraft(key = "welcome", dir: 1 | -1): ClearedDraft | null {
  const st = clearedStash.get(key);
  if (!st || st.items.length === 0) return null;
  if (st.cursor === -1 && dir === 1) st.snapshot = { text: getDraftText(key), files: [...getDraftFiles(key)] };
  st.cursor = Math.min(Math.max(st.cursor + dir, -1), st.items.length - 1);
  return st.cursor === -1 ? st.snapshot : st.items[st.items.length - 1 - st.cursor];
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
