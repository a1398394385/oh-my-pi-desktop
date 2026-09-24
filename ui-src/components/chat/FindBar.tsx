// 会话内查找（⌘F）：消息级定位——跳到命中消息并闪烁强调，不做文本内关键字高亮。
// 迁移自 ui/chat.js 的 findBar 段。索引范围为当前会话 items 中 user/assistant/thinking
// 的纯文本（含 loop 组子项，递归）；key 与 data-fk 锚点同源。
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatItem, LoopItem } from "./chat-types";
import { useAppStore } from "../../store/index";
import { isJunkPlaceholder } from "../../store/session";
import { patchActiveItem } from "./parts";
import Icon from "../../Icon";

// 查找索引项：key 与 items.tsx 的 data-fk 锚点同源
interface FindMatch {
  key: string;
  text: string;
}

// 建文本索引：key 结构 = 顶层下标，或 "loop下标-子下标[-…]"（与 items.tsx 的 data-fk 同源）
function buildFindIndex(s: { items: ChatItem[] }): FindMatch[] {
  const out: FindMatch[] = [];
  const walk = (items: ChatItem[], pfx: string) => {
    items.forEach((it, i) => {
      const key = pfx + i;
      if (it.role === "user" || it.role === "assistant") {
        if (it.role === "assistant" && isJunkPlaceholder(it.text)) return;
        if (it.text) out.push({ key, text: it.text });
      } else if (it.role === "thinking") {
        if (it.thinking) out.push({ key, text: it.thinking });
      }
      if (it.role === "loop") walk(it.items || [], key + "-");
    });
  };
  walk(s.items, "");
  return out;
}

export default function FindBar({ streamRef }: { streamRef: RefObject<HTMLDivElement | null> }) {
  const activePath = useAppStore((s) => s.activePath); // 切会话收起判定依赖（订阅变化触发重渲染）
  const [open, _setOpen] = useState(false);
  // 开合同步到 store：全局快捷键需要知道查找栏开着（Esc 先关查找、不中断生成）；静默写（原无 notify）
  const setOpen = (v: boolean) => {
    _setOpen(v);
    useAppStore.setState({ findOpen: v });
  };
  const [count, setCount] = useState(""); // "1/3" | "无结果" | ""
  const barRef = useRef<HTMLDivElement | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const matchesRef = useRef<FindMatch[]>([]);
  const cursorRef = useRef(-1);
  const pathRef = useRef<string | null>(null); // 打开时所在会话（切换会话收起）

  const close = () => {
    setOpen(false);
    setCount("");
    matchesRef.current = [];
    cursorRef.current = -1;
  };

  const updateCount = () => {
    if (!matchesRef.current.length) {
      setCount("无结果");
      return;
    }
    setCount(`${cursorRef.current + 1}/${matchesRef.current.length}`);
  };

  // 命中元素短暂闪烁强调（背景高亮渐隐）；重触发需先移除类再强制 reflow
  const flashFindTarget = (el: HTMLElement) => {
    el.classList.remove("find-flash");
    void el.offsetWidth;
    el.classList.add("find-flash");
  };

  // 跳转：dir 1=下一个 -1=上一个，循环导航。命中的 loop 子项在组收起时先展开再定位
  const gotoMatch = (dir: number) => {
    const matches = matchesRef.current;
    if (!matches.length) return;
    cursorRef.current = (cursorRef.current + dir + matches.length) % matches.length;
    updateCount();
    const m = matches[cursorRef.current];
    const st = useAppStore.getState();
    const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!s) return;
    const seg = m.key.split("-").map(Number);
    let expanded = false;
    if (seg.length > 1) {
      // key 前缀段全是 loop 容器：逐层下钻，任一层收起都展开（外层收起时内层未渲染）；
      // 展开走拷贝替换（含 _v bump），DOM 就位后再定位（延迟一拍）
      let box: { items?: ChatItem[] } & Partial<Pick<LoopItem, "collapsed">> = { items: s.items };
      for (let k = 0; k < seg.length - 1; k++) {
        const next = box.items?.[seg[k]];
        if (!next) break;
        if (next.role !== "loop") break; // 前缀段按构造必为 loop 容器;非 loop 即索引损坏,终止下钻
        box = next;
        if (box.collapsed) {
          patchActiveItem(next, (it) => { it.collapsed = false; });
          expanded = true;
        }
      }
    }
    const locate = () => {
      // data-fk 锚点即消息容器 div，收窄为 HTMLElement（classList/offsetWidth 需要）
      const el = streamRef.current?.querySelector(`[data-fk="${m.key}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flashFindTarget(el);
    };
    if (expanded) requestAnimationFrame(locate);
    else locate();
  };

  const runFind = () => {
    const st = useAppStore.getState();
    const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!s) return;
    const inp = inpRef.current;
    if (!inp) return;
    const q = inp.value.trim().toLowerCase();
    matchesRef.current = q ? buildFindIndex(s).filter((m) => m.text.toLowerCase().includes(q)) : [];
    cursorRef.current = -1;
    if (matchesRef.current.length) gotoMatch(1);
    else updateCount();
  };

  // ⌘F 打开（preventDefault 阻止 WKWebView 默认行为）；Esc 关闭。
  // 设置页全屏覆盖层打开时不响应（旧版 settingsOpen 检查平移）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        const st = useAppStore.getState();
        if (!st.activePath || !st.openSessions.get(st.activePath) || st.isCreatingNew || st.settingsOpen) return;
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 打开后：浮层贴消息流顶部（absolute 相对 #main，水平居中交 CSS）+ 聚焦全选
  useEffect(() => {
    if (!open) return;
    pathRef.current = activePath;
    const bar = barRef.current;
    if (bar) bar.style.top = (streamRef.current?.offsetTop ?? 0) + 6 + "px";
    const inp = inpRef.current;
    if (!inp) return;
    inp.focus();
    inp.select(); // 已有词时全选，直接输入即覆盖
    if (inp.value.trim()) runFind();
  }, [open]);

  // 切会话即收起（同会话的流式重绘不收；activePath 订阅驱动重渲染）
  useEffect(() => {
    if (open && pathRef.current !== activePath) close();
  });

  if (!open) return null;
  return (
    <div className="find-bar" ref={barRef}>
      <input
        className="find-inp"
        placeholder="在会话中查找…"
        type="text"
        autoComplete="off"
        spellCheck={false}
        ref={inpRef}
        onChange={() => runFind()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            gotoMatch(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className={"find-count" + (count === "无结果" ? " none" : "")}>{count}</span>
      <button className="find-nav" title="上一个 (⇧↵)" onClick={() => gotoMatch(-1)}>
        <Icon name="chevronUp" />
      </button>
      <button className="find-nav" title="下一个 (↵)" onClick={() => gotoMatch(1)}>
        <Icon name="chevronDown" />
      </button>
      <button className="find-nav find-close" title="关闭 (Esc)" onClick={close}>
        <Icon name="xmark" size={12} />
      </button>
    </div>
  );
}
