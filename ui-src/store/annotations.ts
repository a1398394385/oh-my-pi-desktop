// Pending conversation annotations (text selected in assistant output, or in the
// file / diff pane where the note also carries its path + line span), keyed by
// session path so notes taken in one session never ride along with another's
// prompt. They live outside the message flow: the composer shows one aggregated
// chip, and the send path (components/composer/send.ts) consumes them into a
// <conversation_quote> prompt prefix.
import { useAppStore } from "./index";

export interface PendingAnnotation {
  id: number;
  /** Selected text, trimmed. */
  text: string;
  /** User comment; "" when left empty. */
  comment: string;
  /** Subagent name when the quote came from a subagent's output. */
  agent?: string;
  /** Absolute path when the text came from the file / diff pane. */
  file?: string;
  /** New-side line span ("12" or "12-18") inside that file. */
  lines?: string;
}

type NewAnnotation = Omit<PendingAnnotation, "id">;

let seq = 0;

function keyOf(): string {
  return useAppStore.getState().activePath ?? "";
}

export function addAnnotation(a: NewAnnotation): void {
  const text = a.text.trim();
  if (!text) return;
  const key = keyOf();
  useAppStore.setState((st) => ({
    annotations: { ...st.annotations, [key]: [...(st.annotations[key] ?? []), { ...a, text, id: ++seq }] },
  }));
}

/** Put notes from a failed send back in front of newer ones (add order kept). */
export function restoreAnnotations(list: NewAnnotation[]): void {
  if (list.length === 0) return;
  const key = keyOf();
  useAppStore.setState((st) => ({
    annotations: {
      ...st.annotations,
      [key]: [...list.map((a) => ({ ...a, id: ++seq })), ...(st.annotations[key] ?? [])],
    },
  }));
}

export function removeAnnotation(id: number): void {
  const key = keyOf();
  useAppStore.setState((st) => {
    const list = (st.annotations[key] ?? []).filter((a) => a.id !== id);
    const next = { ...st.annotations };
    if (list.length > 0) next[key] = list;
    else delete next[key];
    return { annotations: next };
  });
}

export function clearAnnotations(): void {
  const key = keyOf();
  useAppStore.setState((st) => {
    const next = { ...st.annotations };
    delete next[key];
    return { annotations: next };
  });
}

/** Consume the active session's pending annotations (send path only). */
export function takeAnnotations(): PendingAnnotation[] {
  const st = useAppStore.getState();
  const key = st.activePath ?? "";
  const list = st.annotations[key] ?? [];
  if (list.length === 0) return [];
  useAppStore.setState((s) => {
    const next = { ...s.annotations };
    delete next[key];
    return { annotations: next };
  });
  return list;
}
