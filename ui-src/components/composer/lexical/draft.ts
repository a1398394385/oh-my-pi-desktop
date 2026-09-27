// 模块级输入草稿（按会话/欢迎页隔离）：
// EditorState 快照供挂载恢复（initialConfig.editorState），text 为压平后的纯文本
// （发送 / hasDraft / bash 前缀判定读取）。写入方只有 ComposerPlugin 的 updateListener。
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

// contentEditable 支持探测：happy-dom 等环境 contentEditable 属性可读但缺 Lexical 的
// 运行时依赖(MutationObserver 等,挂载即 ReferenceError)——两项都满足才初始化 Lexical,
// 否则 Composer 降级渲染只读占位,相关操作全部空转(冒烟环境即走此分支)。
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
