// In-session find (⌘F): message-level locating — jumps to the hit message and flashes it;
// no in-text keyword highlighting.
// Migrated from the findBar section of ui/chat.js. The index covers the plain text of
// user/assistant/thinking items in the current session (including loop group sub-items,
// recursively); keys share the same source as the data-fk anchors.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatItem, LoopItem } from "./chat-types";
import { useAppStore } from "../../store/index";
import { isJunkPlaceholder } from "../../store/session";
import { t } from "../../i18n";
import { patchActiveItem } from "./parts";
import Icon from "../../Icon";

// Find index entry: the key shares the same source as the data-fk anchors in items.tsx
interface FindMatch {
  key: string;
  text: string;
}

// Build the text index: key structure = top-level index, or "loopIndex-subIndex[-…]"
// (same source as data-fk in items.tsx)
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
  const activePath = useAppStore((s) => s.activePath); // dependency of the collapse-on-switch check (subscribing to changes triggers re-render)
  const [open, _setOpen] = useState(false);
  // Sync open state to the store: global shortcuts need to know the find bar is open (Esc
  // closes find first and does not interrupt generation); silent write (formerly no notify)
  const setOpen = (v: boolean) => {
    _setOpen(v);
    useAppStore.setState({ findOpen: v });
  };
  const [count, setCount] = useState(""); // "1/3" | the misc.noResults label | ""
  const barRef = useRef<HTMLDivElement | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const matchesRef = useRef<FindMatch[]>([]);
  const cursorRef = useRef(-1);
  const pathRef = useRef<string | null>(null); // the session the bar was opened in (collapses on session switch)

  const close = () => {
    setOpen(false);
    setCount("");
    matchesRef.current = [];
    cursorRef.current = -1;
  };

  const updateCount = () => {
    if (!matchesRef.current.length) {
      setCount(t("misc.noResults"));
      return;
    }
    setCount(`${cursorRef.current + 1}/${matchesRef.current.length}`);
  };

  // Briefly flash the hit element (background highlight fading out); retriggering requires
  // removing the class first and forcing a reflow
  const flashFindTarget = (el: HTMLElement) => {
    el.classList.remove("find-flash");
    void el.offsetWidth;
    el.classList.add("find-flash");
  };

  // Jump: dir 1 = next, -1 = previous, cyclic navigation. A hit inside a collapsed loop
  // sub-item expands the group first, then locates
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
      // All leading key segments are loop containers: drill down level by level, expanding
      // any collapsed one (inner levels are unrendered while an outer one is collapsed);
      // expansion goes through copy-replace (with _v bump), then locate once the DOM is in
      // place (delayed one frame)
      let box: { items?: ChatItem[] } & Partial<Pick<LoopItem, "collapsed">> = { items: s.items };
      for (let k = 0; k < seg.length - 1; k++) {
        const next = box.items?.[seg[k]];
        if (!next) break;
        if (next.role !== "loop") break; // prefix segments are loop containers by construction; a non-loop means the index is corrupt, stop drilling
        box = next;
        if (box.collapsed) {
          patchActiveItem(next, (it) => { it.collapsed = false; });
          expanded = true;
        }
      }
    }
    const locate = () => {
      // The data-fk anchor is the message container div; narrow to HTMLElement (needed for
      // classList/offsetWidth)
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

  // ⌘F opens (preventDefault blocks WKWebView's default behavior); Esc closes.
  // No response while the settings page's fullscreen overlay is open (ported from the old
  // settingsOpen check)
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

  // After opening: the overlay hugs the top of the message stream (absolute relative to
  // #main; horizontal centering left to CSS) + focus and select all
  useEffect(() => {
    if (!open) return;
    pathRef.current = activePath;
    const bar = barRef.current;
    if (bar) bar.style.top = (streamRef.current?.offsetTop ?? 0) + 6 + "px";
    const inp = inpRef.current;
    if (!inp) return;
    inp.focus();
    inp.select(); // select all when a word exists; typing directly overwrites
    if (inp.value.trim()) runFind();
  }, [open]);

  // Collapse on session switch (same-session streaming redraws do not collapse; the
  // activePath subscription drives the re-render)
  useEffect(() => {
    if (open && pathRef.current !== activePath) close();
  });

  if (!open) return null;
  return (
    <div className="find-bar" ref={barRef}>
      <input
        className="find-inp"
        placeholder={t("misc.findPlaceholder")}
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
      <span className={"find-count" + (count === t("misc.noResults") ? " none" : "")}>{count}</span>
      <button className="flex-none w-[22px] h-[22px] rounded-sm inline-flex items-center justify-center text-dim cursor-pointer border-0 bg-none p-0 hover:bg-panel-2 hover:text-text transition-[background,color] duration-150 ease-[var(--swift)]" title={t("misc.prevMatch")} onClick={() => gotoMatch(-1)}>
        <Icon name="chevronUp" />
      </button>
      <button className="flex-none w-[22px] h-[22px] rounded-sm inline-flex items-center justify-center text-dim cursor-pointer border-0 bg-none p-0 hover:bg-panel-2 hover:text-text transition-[background,color] duration-150 ease-[var(--swift)]" title={t("misc.nextMatch")} onClick={() => gotoMatch(1)}>
        <Icon name="chevronDown" />
      </button>
      <button className="flex-none w-[22px] h-[22px] rounded-sm inline-flex items-center justify-center text-dim cursor-pointer border-0 bg-none p-0 hover:bg-panel-2 hover:text-text transition-[background,color] duration-150 ease-[var(--swift)] find-close" title={t("misc.closeFind")} onClick={close}>
        <Icon name="xmark" size={12} />
      </button>
    </div>
  );
}
