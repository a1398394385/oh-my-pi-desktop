// Attachment ingestion shared by every entry point: the picker, clipboard paste and
// the center-column drop. Lives outside Composer because the drop target is the whole
// column (#main), not the input card.
import { useAppStore, toast } from "../store";
import { t } from "../i18n";
import type { PromptAttachment } from "../types/frames";

// Size cap for attachments to send: images go through ImageContent (base64),
// text-like files are inlined into the prompt
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

export async function addIncomingFiles(picked: File[]) {
  const added: (PromptAttachment & { id: number })[] = [];
  for (const file of picked) {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(t("composer.oversizeFile", { name: file.name }));
      continue;
    }
    try {
      if (file.type.startsWith("image/")) {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const r = new FileReader();
        r.onload = () => resolve(r.result as string); // readAsDataURL result is always a dataURL string
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
        const dataUrl = await promise;
        const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
        added.push({ id: 0, name: file.name, kind: "image", mime: file.type, data: b64 });
      } else {
        added.push({ id: 0, name: file.name, kind: "text", mime: file.type || "text/plain", data: await file.text() });
      }
    } catch {
      toast(t("composer.readFail", { name: file.name }));
    }
  }
  if (added.length === 0) return;
  // Attachment append + render trigger merged into one setState (pendingFiles
  // container gets a new reference)
  useAppStore.setState((st) => {
    let seq = st.fileSeq;
    const files = [...st.pendingFiles];
    for (const a of added) files.push({ ...a, id: ++seq });
    return { pendingFiles: files, fileSeq: seq };
  });
}

// Files that arrive as absolute paths (Tauri dialog pick, native drag-drop) skip the browser
// File entirely: the path travels to the host, which appends it as an @mention so the base
// reads it itself (no content copy through the UI, no 10MB cap, video becomes a contact sheet).
export function addIncomingPaths(paths: string[]) {
  const add = paths.filter(Boolean);
  if (add.length === 0) return;
  useAppStore.setState((st) => {
    let seq = st.fileSeq;
    const files = [...st.pendingFiles];
    for (const p of add) {
      if (files.some((it) => it.kind === "path" && it.path === p)) continue;
      files.push({ id: ++seq, kind: "path", path: p, name: p.split(/[\\/]/).pop() || p, mime: "" });
    }
    return { pendingFiles: files, fileSeq: seq };
  });
}
