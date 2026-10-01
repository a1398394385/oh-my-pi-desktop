// Composer 的 Lexical 集成插件（挂 LexicalComposer 内）：
//  · 键盘命令：Enter 发送 / Ctrl+↵ steer（补全面板开着时让路给 TypeaheadMenuPlugin
//    的 LOW 级处理——同旧版「补全态回车 = 接受候选」）、Ctrl+Q 排队、Alt+↑ 拉回排队消息，
//    语义与旧 textarea onKeyDown 逐条对齐；IME commit-Enter guard lives in this plugin
//    (core only covers composition in progress, which misses WebKit ordering where
//    compositionend arrives before the confirming keydown — see IME_COMMIT_ENTER_WINDOW_MS)；
//  · Esc: swallow RichTextPlugin's default editor.blur() (still yields to the typeahead
//    menu to close itself) so focus stays in the input and Esc only drives the global
//    route (double-Esc clear / abort / open tree) — matches the old textarea behavior;
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

// IME 确认选字的回车吞键窗口（ms）：WebKit 上 compositionend 与随后的 Enter keydown
// 几乎同一 tick，窗口只用来覆盖这期间的派发错位，取小值以免误吞「鼠标选字后按下的真回车」
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
  // 补全面板开合（TypeaheadMenuPlugin 的 onOpen/onClose 维护，Composer 传入同一 ref）：
  // Enter / Alt+↑ 在面板开着时让路，避免与候选导航/接受互抢
  typeaheadOpenRef: RefObject<boolean>;
};

export default function ComposerPlugin({ draftKey, handleRef, onTextChange, sendPrompt, typeaheadOpenRef }: Props) {
  const [editor] = useLexicalComposerContext();
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  // 回调经 ref 取最新闭包（sendPrompt 每渲染重建，监听器只注册一次）
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const sendPromptRef = useRef(sendPrompt);
  sendPromptRef.current = sendPrompt;
  // 最近一次 compositionend 的时刻（0 = 无）。Safari/WebKit（= Tauri macOS 的 WKWebView）
  // 确认选字时先派发 compositionend、再派发这次 Enter 的 keydown，事件上 isComposing 已是 false，
  // Lexical 核心的 isComposing 守卫拦不住 → 确认选字的回车被当发送。记录时刻在插件层补这道
  // 守卫（ProseMirror 0c54477 同源对策）。非 Apple 平台顺序相反，恒为 0 不生效。
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
    // compositionstart/end 派发时机早于 root 元素挂载（编辑器在 Composer 内后挂），故走
    // registerRootListener：拿挂载后的 root 元素挂原生监听，不与 Lexical 自己的重入守卫冲突。
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
        // Enter：面板开着 → 让路（Typeahead LOW 级接受候选）；⇧↵ → 让默认插换行；其余发送。
        // Ctrl+↵ steer（无 alt/meta 修饰），⌥↵/⌘↵ 按普通发送（同旧版 Enter 分支无修饰排除）。
        // ev 为 null 的派发只出现在 Lexical 的 composition 收尾路径（组合文本以 \n 结束），
        // 让默认插换行——不借 composition 之机发送，对齐旧 textarea 时代 IME 回车不发送。
        // imeCommitAt 窗口内的无修饰回车 = IME 确认选字，吞掉不发送；只吞一次，
        // 确认后下一次真实回车照常发送。
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
        // Esc：RichTextPlugin 在 EDITOR 优先级上绑了 editor.blur()，输入区按一下 Esc 焦点就外流，
        // 想继续打字必须鼠标点回来——全局 Esc 路由（双击清空 / 中止生成 / 唤起树）不依赖焦点，
        // 在这里抢在 blur 之前吞掉，焦点恒留输入框。面板开着让路给 TypeaheadMenuPlugin 关面板。
        // 不 preventDefault：keydown 继续冒泡到 document 的全局路由（Esc 语义全在那边）。
        editor.registerCommand(
          KEY_ESCAPE_COMMAND,
          () => !typeaheadOpenRef.current,
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
