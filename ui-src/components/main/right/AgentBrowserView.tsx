// Right panel Agent-browser live view (the "agent" mode of the merged browser
// page): agent tab pills + URL row + the CDP screencast still stream mirrored
// by the host (host/browser-mirror.ts over browser_mirror_* RPCs / browser_*
// frames). Follow-the-agent tab selection unless the user pins a tab by hand.
// Session-scoped: only tabs the displayed session created are listed (each tab
// carries ownerPath; see BrowserTabInfo); BrowserPage filters the list and
// passes the hidden other-session count for the empty state.
// Render vehicle note: Tauri v2 has no window-internal child webview,
// and the Agent's Chromium cannot be iframed cross-process — hence the
// screencast mirror instead of embedding the real page.
// Empty state: the displayed session is not browsing (another session's tabs
// are summarized as hidden) — a manual-mode jump is offered.
import { useEffect, useRef, useState } from "react";
import type {
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { useAppStore, type TimerHandle, effZoom } from "../../../store";
import { onBrowserFrame, onBrowserPick } from "../../../store/browserMirror";
import type { BrowserPickedElement, BrowserTabInfo } from "../../../types/frames";
import { getDraftText } from "../../composer/lexical/draft";
import { BrowserModePills, displayBrowserUrl, openExternal, SPECIAL_KEY_NAMES } from "./BrowserPage";

// Picked element as composer text: a data-only header (selector, box, colors,
// font, page URL) the Agent can map back to the page, plus the markup that
// produced it. Deliberately prose-free — it needs no translation and stays
// editable after insertion.
function pickedText(el: BrowserPickedElement, url: string): string {
  const selector = el.tag + (el.id ? `#${el.id}` : "") + el.classes.map((c) => `.${c}`).join("");
  const lines = [`[element] ${selector} ${el.w}×${el.h}`];
  if (el.color) lines.push(`color: ${el.color}`);
  if (el.background) lines.push(`background: ${el.background}`);
  if (el.fontSize) lines.push(`font: ${el.fontSize} ${el.fontFamily}`);
  if (url) lines.push(`url: ${url}`);
  return `${lines.join("\n")}\n\`\`\`html\n${el.html}\n\`\`\``;
}

export function AgentBrowserView({ tabs, others }: { tabs: BrowserTabInfo[]; others: number }) {
  const { t } = useTranslation();
  const viewTab = useAppStore((s) => s.browserViewTab);
  const connected = useAppStore((s) => s.connected);
  const setBrowserMode = useAppStore((s) => s.setBrowserMode);

  const [frame, setFrame] = useState<{ data: string; ts: number; w?: number; h?: number; s?: number } | null>(null);
  // Element picker: `picking` gates pointer capture (the mirror stops forwarding
  // input to the page), `picked` is the element under the pointer as last probed.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<BrowserPickedElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Hidden textarea under the still: the keyboard sink that gives IME a
  // composition host (a plain div receives no composition events).
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const knownNames = useRef<Set<string> | null>(null);
  const resizeTimer = useRef<TimerHandle | undefined>(undefined);
  const lastMoveAt = useRef(0);

  const current = tabs.find((tb) => tb.name === viewTab) ?? null;

  // Follow-the-agent selection: unless pinned, jump to newly opened tabs and
  // drop selections that vanished; the first snapshot never yanks.
  useEffect(() => {
    const names = tabs.map((tb) => tb.name);
    const known = knownNames.current ?? new Set(names);
    knownNames.current = new Set(names);
    const st = useAppStore.getState();
    let want = st.browserViewTab;
    if (!st.browserPinned) {
      const fresh = names.find((name) => !known.has(name));
      if (fresh !== undefined) want = fresh;
      else if (want === null || !names.includes(want)) want = names[0] ?? null;
    } else if (want !== null && !names.includes(want)) {
      want = names[0] ?? null;
    }
    if (want !== st.browserViewTab) {
      useAppStore.setState({ browserViewTab: want });
      if (want !== null) useAppStore.getState().send({ type: "browser_mirror_select", name: want });
    }
  }, [tabs]);

  // Subscribe to the host screencast + land stills in local state (2-8/s, no
  // zustand). Re-subscribes on reconnect (host forgot the subscription) and on
  // resize / UI zoom (subscribe carries the width; the host restarts the cast
  // at the new maxWidth). The width is PHYSICAL pixels: layout px × device
  // pixel ratio × UI zoom — the cast must outresolve the display, else stills
  // are upscaled and text turns mushy.
  useEffect(() => {
    if (!connected) return;
    const physWidth = (cssWidth: number): number =>
      Math.max(200, Math.round(cssWidth * (window.devicePixelRatio || 1) * effZoom()));
    const box = boxRef.current;
    useAppStore.getState().send({ type: "browser_mirror_subscribe", width: physWidth(box?.clientWidth ?? 640) });
    const off = onBrowserFrame((f) => {
      if (f.name !== useAppStore.getState().browserViewTab) return;
      setFrame({ data: f.data, ts: f.ts, w: f.w, h: f.h, s: f.s });
    });
    const ro = new ResizeObserver((entries) => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        const width = physWidth(entries[0]?.contentRect.width ?? 640);
        useAppStore.getState().send({ type: "browser_mirror_subscribe", width });
      }, 400);
    });
    // CSS zoom changes layout width without firing ResizeObserver — ride the
    // app-wide omp:zoom event (same reason the composer recomputes on it).
    const onZoom = (): void => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        useAppStore.getState().send({ type: "browser_mirror_subscribe", width: physWidth(boxRef.current?.clientWidth ?? 640) });
      }, 400);
    };
    window.addEventListener("omp:zoom", onZoom);
    if (box) ro.observe(box);
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener("omp:zoom", onZoom);
      clearTimeout(resizeTimer.current);
      setFrame(null);
      useAppStore.getState().send({ type: "browser_mirror_unsubscribe" });
    };
  }, [connected]);

  const pickTab = (name: string) => {
    if (name === viewTab) return;
    setFrame(null);
    useAppStore.getState().setBrowserViewTab(name, true); // explicit pick: pinned
  };

  // ---- Interactive mirror: map viewport events to page CSS coordinates and
  // post browser_input (the host forwards via the CDP Input domain) ----
  const buttonName = (b: number): string => (b === 1 ? "middle" : b === 2 ? "right" : "left");
  const sendInput = (payload: Record<string, unknown>): void => {
    if (!frame || !viewTab) return;
    useAppStore.getState().send({ type: "browser_input", name: viewTab, ...payload });
  };
  const toPage = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0 || !frame?.w || !frame?.h) return null;
    // Contain-fit keeps the element box at the bitmap aspect (aspect-ratio
    // style below), so the fraction maps straight onto the page viewport.
    const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const scale = frame.s && frame.s > 0 ? frame.s : 1;
    return { x: fx * (frame.w / scale), y: fy * (frame.h / scale) };
  };

  // ---- Element picker: the host probes the node under the pointer and paints
  // the highlight into the screencast stills, so the UI only forwards coordinates
  // and keeps the last probe result for the commit write ----
  useEffect(() => {
    const off = onBrowserPick((f) => {
      if (f.name !== useAppStore.getState().browserViewTab) return;
      setPicked(f.element);
    });
    return () => {
      off();
    };
  }, []);

  const stopPicking = (): void => {
    setPicking(false);
    setPicked(null);
    if (viewTab) useAppStore.getState().send({ type: "browser_pick", name: viewTab, op: "end" });
  };

  // Tab switch/unmount drops the page-side highlight too (the close signal is
  // keyed by tab name, so it has to go out before viewTab moves on).
  useEffect(() => {
    if (!picking || !viewTab) return;
    const name = viewTab;
    return () => useAppStore.getState().send({ type: "browser_pick", name, op: "end" });
  }, [picking, viewTab]);

  const commitPick = (): void => {
    // No resolved element (nothing under the pointer / box model unavailable):
    // leave the picker instead of swallowing the click.
    if (!picked) {
      stopPicking();
      return;
    }
    const draftKey = useAppStore.getState().activePath || "welcome";
    const prev = getDraftText(draftKey).trimEnd();
    const block = pickedText(picked, current?.url ?? "");
    useAppStore.getState().setComposerValue(prev ? `${prev}\n\n${block}` : block, []);
    stopPicking();
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    (imeRef.current ?? e.currentTarget).focus();
    if (picking) {
      commitPick();
      return;
    }
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput({ op: "mouse", action: "down", x: Math.round(p.x), y: Math.round(p.y), button: buttonName(e.button), count: e.detail });
  };
  const onMouseUp = (e: ReactMouseEvent) => {
    if (picking) return;
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput({ op: "mouse", action: "up", x: Math.round(p.x), y: Math.round(p.y), button: buttonName(e.button), count: e.detail });
  };
  const onMouseMove = (e: ReactMouseEvent) => {
    const now = performance.now();
    if (now - lastMoveAt.current < 60) return;
    lastMoveAt.current = now;
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    if (picking) {
      if (viewTab) useAppStore.getState().send({ type: "browser_pick", name: viewTab, op: "probe", x: Math.round(p.x), y: Math.round(p.y) });
      return;
    }
    sendInput({ op: "mouse", action: "move", x: Math.round(p.x), y: Math.round(p.y) });
  };

  // Wheel must be non-passive to preventDefault (React's onWheel is passive
  // at the root), so it rides a manual listener instead.
  useEffect(() => {
    const view = boxRef.current;
    if (!view || !frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (picking) return; // picking owns the pointer: no page scroll under it
      const p = toPage(e.clientX, e.clientY);
      if (p) sendInput({ op: "wheel", x: Math.round(p.x), y: Math.round(p.y), deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
    };
    view.addEventListener("wheel", onWheel, { passive: false });
    return () => view.removeEventListener("wheel", onWheel);
  }, [frame, viewTab, picking]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // The mirror owns the keyboard while focused: keep every key from bubbling
    // up to the app-wide document shortcuts (Esc routing, Shift+Tab thinking).
    e.stopPropagation();
    if (picking) {
      e.preventDefault();
      if (e.key === "Escape") stopPicking();
      return;
    }
    // The IME owns keystrokes until it commits; forwarding the pinyin letters
    // here would type them into the page and lose the composed result. 229 is
    // the IME placeholder keydown WebKit fires before compositionstart.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // CDP Input.dispatchKeyEvent modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const special = SPECIAL_KEY_NAMES[e.key];
    if (special) {
      e.preventDefault();
      sendInput({ op: "key", action: "down", key: special, modifiers });
      sendInput({ op: "key", action: "up", key: special, modifiers });
      return;
    }
    // Printable characters (and modifier combos like ⌘V/⌘A) travel as key
    // events WITH text: `Input.insertText` only produces an `input` event, so
    // page keydown/keypress shortcuts and combobox navigation never see them,
    // and it is silently dropped without a focused editable element.
    if (e.key.length === 1) {
      e.preventDefault();
      sendInput({
        op: "key",
        action: "down",
        key: e.key,
        text: e.key,
        code: e.code,
        vk: e.keyCode,
        modifiers,
      });
      sendInput({ op: "key", action: "up", key: e.key, code: e.code, vk: e.keyCode, modifiers });
    }
  };

  const onCompositionStart = (): void => {
    composing.current = true;
  };
  // IME commit: the composed text has no key events of its own, so it goes out
  // once as a text input (host: Input.insertText).
  const onCompositionEnd = (e: ReactCompositionEvent<HTMLDivElement>): void => {
    composing.current = false;
    if (imeRef.current) imeRef.current.value = "";
    if (e.data) sendInput({ op: "text", text: e.data });
  };
  // The sink must stay empty: text typed into it is forwarded (and prevented),
  // composition text is cleared on commit, but never let leftovers accumulate.
  const onImeInput = (): void => {
    if (!composing.current && imeRef.current) imeRef.current.value = "";
  };
  // Losing focus mid-composition (click on the toolbar) must not leave the
  // swallow flag armed for the next focus.
  const onImeBlur = (): void => {
    composing.current = false;
    if (imeRef.current) imeRef.current.value = "";
  };

  // Not browsing in THIS session: empty state with a manual-mode jump. Other
  // sessions' tabs stay out of view (summarized as a count line).
  if (tabs.length === 0) {
    return (
      <>
        <div className="bpane-bar">
          <BrowserModePills />
        </div>
        <div className="bpane-view">
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="monitor" size={30} /></span>
            <div className="bpane-empty-tt">{t("right.mirrorEmpty")}</div>
            {others > 0 && (
              <div className="bpane-empty-sub">{t("right.mirrorOtherSessions", { n: others })}</div>
            )}
            <div className="bpane-err-acts">
              <button className="btn" onClick={() => setBrowserMode("manual")}>{t("right.modeManual")}</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Toolbar: mode pills / agent tab pills / live badge / open external */}
      <div className="bpane-bar">
        <BrowserModePills />
        <div className="bpane-tabs">
          {tabs.map((tb) => (
            <button
              key={tb.name}
              className={"bpill" + (tb.name === viewTab ? " on" : "")}
              title={tb.url}
              onClick={() => pickTab(tb.name)}
            >
              {tb.name}
            </button>
          ))}
        </div>
        <div className="bpane-live-badge" title={t("right.agentLiveSub")}>
          <span className="bpane-live-dot" />
          {t("right.agentLive")}
        </div>
        <div className="bpane-spacer" />
        <button
          className={"icon-btn" + (picking ? " on" : "")}
          title={picking ? t("right.pickHint") : t("right.pickElement")}
          disabled={!frame}
          onClick={() => (picking ? stopPicking() : setPicking(true))}
        >
          <Icon name="pick" size={14} />
        </button>
        <button
          className="icon-btn"
          title={t("right.openExternal")}
          disabled={!current}
          onClick={() => current && openExternal(current.url)}
        >
          <Icon name="externalOpen" size={14} />
        </button>
      </div>
      {/* URL row: current tab's page URL (host poll projection) */}
      <div className="bpane-urlrow" title={current?.url ?? ""}>
        {current ? displayBrowserUrl(current.url) || current.url : t("right.agentNoTab")}
      </div>
      {/* Viewport: live screencast still (interactive: click/scroll/type are
          forwarded into the page) / connecting / not-mirrorable states */}
      <div
        className={"bpane-view bpane-liveview" + (frame ? " interactive" : "") + (picking ? " picking" : "")}
        ref={boxRef}
        style={{ position: "relative" }}
        title={frame ? (picking ? t("right.pickHint") : t("right.agentInteract")) : undefined}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onContextMenu={(e) => e.preventDefault()}
      >
        {frame ? (
          <>
            <img
              ref={imgRef}
              className="bpane-live-img"
              src={"data:image/jpeg;base64," + frame.data}
              alt=""
              draggable={false}
              style={frame.w && frame.h ? { aspectRatio: `${frame.w} / ${frame.h}` } : undefined}
            />
            {/* Keyboard/IME sink over the still (transparent): a div is not an
                editing host, so composition events need a real editable. Tab
                focus and clicks land here, IME candidates anchor at its caret. */}
            <textarea
              ref={imeRef}
              className="bpane-ime"
              aria-label={t("right.agentInteract")}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onInput={onImeInput}
              onBlur={onImeBlur}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                margin: 0,
                padding: 0,
                border: 0,
                resize: "none",
                outline: "none",
                background: "transparent",
                color: "transparent",
                caretColor: "transparent",
                opacity: 0,
                cursor: "inherit",
              }}
            />
          </>
        ) : (
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="monitor" size={30} /></span>
            <div className="bpane-empty-tt">
              {current && !current.mirrorable ? t("right.agentNoMirror") : t("right.agentConnecting")}
            </div>
            <div className="bpane-empty-sub">{current?.title || current?.url || ""}</div>
          </div>
        )}
      </div>
    </>
  );
}
