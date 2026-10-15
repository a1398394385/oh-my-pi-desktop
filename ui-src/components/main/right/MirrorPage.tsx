// Right panel Agent-browser mirror page ("mirror" tab): the Agent live view split
// out of BrowserPage — tab pills + URL row + the CDP screencast still stream
// mirrored by the host (host/browser-mirror.ts over browser_mirror_* RPCs /
// browser_* frames). Follow-the-agent tab selection unless the user pins a tab
// by hand. Session-scoped since the owner-tab split: only tabs the displayed
// session created are listed (each tab carries ownerPath; see BrowserTabInfo).
// Render vehicle note: Tauri v2 has no window-internal child webview,
// and the Agent's Chromium cannot be iframed cross-process — hence the
// screencast mirror instead of embedding the real page.
// Empty state: the displayed session is not browsing (another session's tabs
// are summarized as hidden) — a manual-browse jump to the "browser" tab is
// offered.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { useAppStore, type TimerHandle } from "../../../store";
import { onBrowserFrame } from "../../../store/browserMirror";
import type { BrowserTabInfo } from "../../../types/frames";
import { openRightTab } from "./tabs";
import { SPECIAL_KEY_NAMES, displayBrowserUrl, openExternal } from "./BrowserPage";

export default function MirrorPage() {
  const { t } = useTranslation();
  const tabs = useAppStore((s) => s.browserTabs);
  const activePath = useAppStore((s) => s.activePath);
  // Session-scoped list: only the displayed session's tabs show here. Tabs
  // without a matching ownerPath (other sessions / unowned) are filtered out.
  const myTabs = useMemo(
    () => tabs.filter((tb) => tb.ownerPath === activePath),
    [tabs, activePath],
  );
  if (myTabs.length === 0) {
    // Not browsing in THIS session; other sessions' tabs stay out of view
    const others = tabs.length - myTabs.length;
    return (
      <div className="bpane">
        <div className="bpane-view">
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="monitor" size={30} /></span>
            <div className="bpane-empty-tt">{t("right.mirrorEmpty")}</div>
            {others > 0 && (
              <div className="bpane-empty-sub">{t("right.mirrorOtherSessions", { n: others })}</div>
            )}
            <div className="bpane-err-acts">
              <button className="btn" onClick={() => openRightTab("browser")}>{t("right.modeManual")}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <AgentBrowserView tabs={myTabs} />;
}

// ---------- Agent live view ----------
function AgentBrowserView({ tabs }: { tabs: BrowserTabInfo[] }) {
  const { t } = useTranslation();
  const viewTab = useAppStore((s) => s.browserViewTab);
  const connected = useAppStore((s) => s.connected);

  const [frame, setFrame] = useState<{ data: string; ts: number; w?: number; h?: number; s?: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
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
      Math.max(200, Math.round(cssWidth * (window.devicePixelRatio || 1) * (useAppStore.getState().zoomLevel || 1)));
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

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.focus();
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput({ op: "mouse", action: "down", x: Math.round(p.x), y: Math.round(p.y), button: buttonName(e.button), count: e.detail });
  };
  const onMouseUp = (e: ReactMouseEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput({ op: "mouse", action: "up", x: Math.round(p.x), y: Math.round(p.y), button: buttonName(e.button), count: e.detail });
  };
  const onMouseMove = (e: ReactMouseEvent) => {
    const now = performance.now();
    if (now - lastMoveAt.current < 60) return;
    lastMoveAt.current = now;
    const p = toPage(e.clientX, e.clientY);
    if (p) sendInput({ op: "mouse", action: "move", x: Math.round(p.x), y: Math.round(p.y) });
  };

  // Wheel must be non-passive to preventDefault (React's onWheel is passive
  // at the root), so it rides a manual listener instead.
  useEffect(() => {
    const view = boxRef.current;
    if (!view || !frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toPage(e.clientX, e.clientY);
      if (p) sendInput({ op: "wheel", x: Math.round(p.x), y: Math.round(p.y), deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
    };
    view.addEventListener("wheel", onWheel, { passive: false });
    return () => view.removeEventListener("wheel", onWheel);
  }, [frame, viewTab]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // app shortcuts pass through
    if (e.key.length === 1) {
      e.preventDefault();
      sendInput({ op: "text", text: e.key });
      return;
    }
    const special = SPECIAL_KEY_NAMES[e.key];
    if (!special) return;
    e.preventDefault();
    sendInput({ op: "key", action: "down", key: special });
    sendInput({ op: "key", action: "up", key: special });
  };

  return (
    <div className="bpane">
      {/* Toolbar: agent tab pills / live badge / manual-browse jump / open external */}
      <div className="bpane-bar">
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
        <div className="mcp-type-pills">
          <button className="mcp-type-pill" onClick={() => openRightTab("browser")}>{t("right.modeManual")}</button>
        </div>
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
        className={"bpane-view bpane-liveview" + (frame ? " interactive" : "")}
        ref={boxRef}
        tabIndex={frame ? 0 : -1}
        title={frame ? t("right.agentInteract") : undefined}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {frame ? (
          <img
            ref={imgRef}
            className="bpane-live-img"
            src={"data:image/jpeg;base64," + frame.data}
            alt=""
            draggable={false}
            style={frame.w && frame.h ? { aspectRatio: `${frame.w} / ${frame.h}` } : undefined}
          />
        ) : (
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="monitor" size={30} /></span>
            <div className="bpane-empty-tt">
              {current && !current.mirrorable ? t("right.agentNoMirror") : t("right.agentConnecting")}
            </div>
            <div className="bpane-empty-sub">{current ? current.title || current.url : ""}</div>
          </div>
        )}
      </div>
    </div>
  );
}
