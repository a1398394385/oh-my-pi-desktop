// Composer 的 Lexical 集成插件（挂 LexicalComposer 内）：
//  · 键盘命令：Enter 发送 / Ctrl+↵ steer（补全面板开着时让路给 TypeaheadMenuPlugin
//    的 LOW 级处理——同旧版「补全态回车 = 接受候选」）、Ctrl+Q 排队、Alt+↑ 拉回排队消息，
//    语义与旧 textarea onKeyDown 逐条对齐；IME 组合期 Lexical 核心不派发任何 keydown
//    command（isComposing 守卫在核心层），等价旧版 isComposing 检查；
//  · 粘贴强制纯文本（insertRawText），杜绝富文本样式混入（对齐 textarea 行为）；
//  · updateListener：同步模块级草稿（EditorState 快照 + 压平纯文本），文本变化回调
//    外层刷新（发送钮 ready 态 / bash-mode 类，等价旧 onInput 里的 notify）；
//  · 句柄（focus / setText / clear）经 handleRef 暴露给 Composer，替代旧 taRef 操作。
import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref, RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $createParagraphNode,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
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

export type ComposerHandle = {
  focus(): void;
  setText(text: string): void;
  clear(): void;
};

type Props = {
  handleRef: Ref<ComposerHandle>;
  onTextChange: (text: string) => void;
  sendPrompt: (steer: boolean) => void;
  // 补全面板开合（TypeaheadMenuPlugin 的 onOpen/onClose 维护，Composer 传入同一 ref）：
  // Enter / Alt+↑ 在面板开着时让路，避免与候选导航/接受互抢
  typeaheadOpenRef: RefObject<boolean>;
};

export default function ComposerPlugin({ handleRef, onTextChange, sendPrompt, typeaheadOpenRef }: Props) {
  const [editor] = useLexicalComposerContext();
  // 回调经 ref 取最新闭包（sendPrompt 每渲染重建，监听器只注册一次）
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const sendPromptRef = useRef(sendPrompt);
  sendPromptRef.current = sendPrompt;

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

  useEffect(
    () =>
      mergeRegister(
        // Enter：面板开着 → 让路（Typeahead LOW 级接受候选）；⇧↵ → 让默认插换行；其余发送。
        // Ctrl+↵ steer（无 alt/meta 修饰），⌥↵/⌘↵ 按普通发送（同旧版 Enter 分支无修饰排除）。
        // ev 为 null 的派发只出现在 Lexical 的 composition 收尾路径（组合文本以 \n 结束），
        // 让默认插换行——不借 composition 之机发送，对齐旧 textarea 时代 IME 回车不发送
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (ev) => {
            if (typeaheadOpenRef.current) return false;
            if (!ev || ev.shiftKey) return false;
            ev.preventDefault();
            ev.stopPropagation();
            sendPromptRef.current(!!(ev.ctrlKey && !ev.altKey && !ev.metaKey));
            return true;
          },
          COMMAND_PRIORITY_NORMAL,
        ),
        // Alt+↑：拉回排队消息（后发先回）——先 steer 队列，空则待发送队列；
        // 面板开着让路（候选导航），无会话 / 两个队列都空时不拦截默认行为
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
        // Ctrl+Q：进待发送队列（面板开着同样可用，旧版 palette 拦截块不含 q）
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
        // 粘贴只取纯文本（\n 经 insertRawText 转为 LineBreakNode，压平规则互逆）
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
        // 吞掉富文本格式命令（Ctrl+B/I/U 等）：纯文本输入区，保持与旧 textarea 一致
        editor.registerCommand(
          FORMAT_TEXT_COMMAND,
          () => true,
          COMMAND_PRIORITY_NORMAL,
        ),
        // 草稿同步：每次 update 保存 EditorState 快照（挂载位切换恢复）与压平文本；
        // 文本变化才回调外层（发送钮态等），selection-only 更新不触发重渲染
        editor.registerUpdateListener(() => {
          const text = editor.read(() => $flattenText());
          const changed = text !== getDraftText();
          saveDraft(editor.getEditorState(), text);
          if (changed) onTextChangeRef.current(text);
        }),
      ),
    [editor, typeaheadOpenRef],
  );

  return null;
}
