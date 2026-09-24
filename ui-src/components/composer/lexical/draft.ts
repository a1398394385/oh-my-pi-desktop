// 模块级输入草稿（跨 Composer 挂载位保留，等价旧 textarea 时代的 draft.value 单例）：
// EditorState 快照供挂载恢复（initialConfig.editorState），text 为压平后的纯文本
// （发送 / hasDraft / bash 前缀判定读取）。写入方只有 ComposerPlugin 的 updateListener。
import type { EditorState } from "lexical";

let state: EditorState | null = null;
let text = "";

export function getDraftState(): EditorState | null {
  return state;
}

export function getDraftText(): string {
  return text;
}

export function saveDraft(nextState: EditorState, nextText: string): void {
  state = nextState;
  text = nextText;
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
