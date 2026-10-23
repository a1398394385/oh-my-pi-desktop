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

// Input history (per composer slot, module-level = gone at app exit): both
// successfully sent prompts and drafts cleared with double-Esc land here
// while the composer.recallClearedDrafts setting is on; with an empty input,
// plain ↑ enters history-browse and ↑/↓ walk it back into the composer (any
// user edit exits the mode). cursor -1 = the live draft (browsing base
// snapshot), 0..n-1 = history entries oldest-to-newest.
export interface HistoryEntry {
  text: string;
  files: PendingFile[];
}
const historyStash = new Map<string, { items: HistoryEntry[]; cursor: number; snapshot: HistoryEntry | null }>();

// Cap per slot: sent prompts accumulate quickly, keep the stash bounded.
const HISTORY_LIMIT = 100;

export function pushInputHistory(key = "welcome", entry?: { text: string; files: PromptAttachment[] }): void {
  const d = entry ?? getDraft(key);
  if (!d.text.trim() && d.files.length === 0) return;
  const st = historyStash.get(key) ?? { items: [], cursor: -1, snapshot: null };
  // Consecutive duplicate (re-send of the previous entry): keep one
  if (st.items[st.items.length - 1]?.text !== d.text) {
    // Stashed chips carry frontend-local negative ids so recalled ones never
    // collide with the live fileSeq counter
    const files: PendingFile[] = d.files.map((f, i) => {
      const pf = f as PendingFile;
      return pf.id !== undefined ? pf : { ...f, id: -(i + 1) };
    });
    st.items.push({ text: d.text, files });
    if (st.items.length > HISTORY_LIMIT) st.items.shift();
  }
  st.cursor = -1;
  st.snapshot = null;
  historyStash.set(key, st);
}
// Re-arm browsing at the live-draft base without pushing anything: used when
// the empty-input ↑ enters history-browse, so each entry starts at the newest
// history item and ↓ can come back to the (empty) snapshot.
export function resetHistoryCursor(key = "welcome"): void {
  const st = historyStash.get(key);
  if (st) {
    st.cursor = -1;
    st.snapshot = null;
  }
}

// Move the browsing cursor one step (dir 1 = older, -1 = newer) and return the
// entry to show; null = history empty. cursor -1 = the live draft (pre-browsing
// snapshot, possibly empty), 0 = newest history entry, n-1 = oldest.
export function recallHistory(key = "welcome", dir: 1 | -1): HistoryEntry | null {
  const st = historyStash.get(key);
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
