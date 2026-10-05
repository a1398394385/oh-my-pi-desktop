// Right panel browser page. Two modes:
// - Agent live view (default while the Agent's built-in browser has tabs): tab
//   pills + URL row + a CDP screencast still stream mirrored by the host
//   (host/browser-mirror.ts over browser_mirror_* RPCs / browser_* frames).
//   Follow-the-agent tab selection unless the user pins a tab by hand.
// - Manual browse (the original ZCode-style embedded iframe): address bar +
//   sandboxed iframe + open-external fallback, unchanged.
// Render vehicle note: Tauri v2 has no window-internal child webview, and the
// Agent's Chromium cannot be iframed cross-process — hence the screencast
// mirror instead of embedding the real page.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { invoke, toast, useAppStore, type TimerHandle } from "../../store";
import { onBrowserFrame } from "../../store/browserMirror";
import { t } from "../../i18n";

// ---------- URL normalization (simplified embeddedBrowserHelpers.normalizeBrowserUrl) ----------
// Without a scheme: localhost/loopback/intranet IPs/explicit port -> http, others -> https
// (aligned with modern browser address bars)
const LOOPBACK_RE = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const HOST_PORT_RE = /^[\w.-]+:\d+([\/?#]|$)/;
export function normalizeBrowserUrl(raw: unknown): string | null {
  let u = String(raw ?? "").trim();
  if (!u) return null;
  if (/^javascript:/i.test(u)) return null; // block pseudo-protocol injection into the iframe
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
    u = LOOPBACK_RE.test(u) || HOST_PORT_RE.test(u) ? "http://" + u : "https://" + u;
  }
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}
// Address bar display: strip https:// and the trailing slash
function displayBrowserUrl(href: string): string {
  try {
    const u = new URL(href);
    return (u.protocol === "https:" || u.protocol === "http:" ? u.host + u.pathname + u.search + u.hash : href).replace(/\/$/, "");
  } catch {
    return href;
  }
}

// Load timeout: exceeding it counts as a load failure (cross-origin iframes give no error events; timeout is the only fallback)
const LOAD_TIMEOUT_MS = 20000;

// e.key -> host special-key name (host/browser-mirror.ts SPECIAL_KEYS);
// printable characters travel as op "text" instead.
const SPECIAL_KEY_NAMES: Record<string, string> = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
  Delete: "delete",
  ArrowLeft: "arrowleft",
  ArrowUp: "arrowup",
  ArrowRight: "arrowright",
  ArrowDown: "arrowdown",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

async function openExternal(url: string) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    toast(t("right.openLinkFailed", { err: String(err) }));
  }
}

export default function BrowserPage() {
  const hasAgent = useAppStore((s) => s.browserTabs.length > 0);
  // Fresh mounts default to the agent view when it is live; the choice is
  // local so switching tabs/pages and back re-follows the Agent.
  const [mode, setMode] = useState<"agent" | "manual">(hasAgent ? "agent" : "manual");
  if (mode === "agent" && hasAgent) return <AgentBrowserView onManual={() => setMode("manual")} />;
  return <ManualBrowserView agentActive={hasAgent} onAgent={() => setMode("agent")} />;
}

// ---------- Agent live view ----------
function AgentBrowserView({ onManual }: { onManual: () => void }) {
  const { t } = useTranslation();
  const tabs = useAppStore((s) => s.browserTabs);
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
  // resize (subscribe carries the width; the host reconfigures maxWidth).
  useEffect(() => {
    if (!connected) return;
    const box = boxRef.current;
    useAppStore.getState().send({ type: "browser_mirror_subscribe", width: Math.round(box?.clientWidth ?? 640) });
    const off = onBrowserFrame((f) => {
      if (f.name !== useAppStore.getState().browserViewTab) return;
      setFrame({ data: f.data, ts: f.ts, w: f.w, h: f.h, s: f.s });
    });
    const ro = new ResizeObserver((entries) => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        const width = Math.max(200, Math.round(entries[0]?.contentRect.width ?? 640));
        useAppStore.getState().send({ type: "browser_mirror_subscribe", width });
      }, 400);
    });
    if (box) ro.observe(box);
    return () => {
      off();
      ro.disconnect();
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
      {/* Toolbar: agent tab pills / live badge / mode pills / open external */}
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
          <button className="mcp-type-pill on">{t("right.modeAgent")}</button>
          <button className="mcp-type-pill" onClick={onManual}>{t("right.modeManual")}</button>
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
            <span className="bpane-empty-ic"><Icon name="globe" size={30} /></span>
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

// ---------- Manual browse view (original embedded iframe browser) ----------
function ManualBrowserView({ agentActive, onAgent }: { agentActive: boolean; onAgent: () => void }) {
  // Navigation stack: history is unreadable from a cross-origin iframe, so back/forward run on a self-built stack
  const { t } = useTranslation();
  const [stack, setStack] = useState<string[]>([]); // loaded URL sequence (incl. current)
  const [idx, setIdx] = useState(-1); // current position in the stack
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false); // load-failed state (timeout/abort)
  const [nonce, setNonce] = useState(0); // for reload: force-reload the same URL
  const [addr, setAddr] = useState(""); // address bar input value
  const [menuOpen, setMenuOpen] = useState(false);
  const loadTimer = useRef<TimerHandle | undefined>(undefined); // DOM setTimeout handle; undefined has the old null semantics (clearTimeout tolerates it)

  const current = idx >= 0 ? stack[idx] : null;
  const canBack = idx > 0;
  const canForward = idx < stack.length - 1;

  // Navigate: push truncates the forward branch, drives the iframe's src change
  const navigate = (href: string | null) => {
    if (!href) {
      toast(t("right.invalidUrl"));
      return;
    }
    clearTimeout(loadTimer.current);
    setStack((prev) => [...prev.slice(0, idx + 1), href]);
    setIdx((i) => i + 1);
    setAddr(displayBrowserUrl(href));
    setLoading(true);
    setFailed(false);
    loadTimer.current = setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, LOAD_TIMEOUT_MS);
  };

  const goBack = () => {
    if (!canBack) return;
    clearTimeout(loadTimer.current);
    setIdx(idx - 1);
    setAddr(displayBrowserUrl(stack[idx - 1]));
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };

  const goForward = () => {
    if (!canForward) return;
    clearTimeout(loadTimer.current);
    setIdx(idx + 1);
    setAddr(displayBrowserUrl(stack[idx + 1]));
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };

  const reload = () => {
    if (!current) return;
    clearTimeout(loadTimer.current);
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };

  const retry = () => {
    setFailed(false);
    reload();
  };

  // iframe finished loading (cross-origin pages still fire load — as long as the server returned content)
  const onIframeLoad = () => {
    clearTimeout(loadTimer.current);
    setLoading(false);
    setFailed(false);
  };

  // Clear the timeout on unmount
  useEffect(() => () => clearTimeout(loadTimer.current), []);
  // The more-menu closes in coordination with the global menu
  useEffect(() => {
    const close = () => setMenuOpen(false);
    document.addEventListener("omp:close-menus", close);
    return () => document.removeEventListener("omp:close-menus", close);
  }, []);

  const submitAddr = () => {
    const href = normalizeBrowserUrl(addr);
    if (!href) {
      toast(t("right.invalidUrl"));
      return;
    }
    if (href === current) reload();
    else navigate(href);
  };

  return (
    <div className="bpane">
      {/* Toolbar: back / forward / reload / address bar / mode / open external / more */}
      <div className="bpane-bar">
        <button className="icon-btn" title={t("right.back")} disabled={!canBack} onClick={goBack}>
          <Icon name="back" size={14} />
        </button>
        <button className="icon-btn" title={t("right.forward")} disabled={!canForward} onClick={goForward}>
          <Icon name="forward" size={14} />
        </button>
        <button className="icon-btn" title={t("right.refresh")} disabled={!current} onClick={reload}>
          <Icon name="rotateRight" size={14} />
        </button>
        <div className={"bpane-addr" + (loading ? " loading" : "")}>
          {loading && <span className="bpane-spin" />}
          <input
            className="bpane-input"
            value={addr}
            placeholder={t("right.urlPh")}
            spellCheck={false}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAddr();
              if (e.key === "Escape") setAddr(current ? displayBrowserUrl(current) : "");
            }}
            onFocus={(e) => e.target.select()}
          />
        </div>
        {agentActive && (
          <div className="mcp-type-pills">
            <button className="mcp-type-pill" onClick={onAgent}>{t("right.modeAgent")}</button>
            <button className="mcp-type-pill on">{t("right.modeManual")}</button>
          </div>
        )}
        <button
          className="icon-btn"
          title={t("right.openExternal")}
          disabled={!current}
          onClick={() => current && openExternal(current)}
        >
          <Icon name="externalOpen" size={14} />
        </button>
        <div className="bpane-more-wrap">
          <button
            className="icon-btn"
            title={t("right.more")}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
          >
            <Icon name="dots" size={15} />
          </button>
          {menuOpen && (
            <div className="menu open bpane-menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="mi"
                disabled={!current}
                onClick={() => {
                  setMenuOpen(false);
                  if (current) navigator.clipboard.writeText(current).then(() => toast(t("right.linkCopied"))).catch(() => toast(t("right.copyFailed")));
                }}
              >
                <span className="mi-ic"><Icon name="globe" size={14} /></span>
                {t("right.copyLink")}
              </button>
              <button
                className="mi"
                disabled={!current}
                onClick={() => {
                  setMenuOpen(false);
                  if (current) openExternal(current);
                }}
              >
                <span className="mi-ic"><Icon name="externalOpen" size={14} /></span>
                {t("right.openExternal")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Viewport: empty state / iframe / load-error state, three stacked states */}
      <div className="bpane-view">
        {!current && (
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="globe" size={30} /></span>
            <div className="bpane-empty-tt">{t("right.browseEmptyTitle")}</div>
            <div className="bpane-empty-sub">
              {t("right.browseEmptySub")}
            </div>
          </div>
        )}
        {current && (
          <iframe
            key={idx + ":" + nonce}
            className="bpane-frame"
            src={current}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            onLoad={onIframeLoad}
          />
        )}
        {current && failed && (
          <div className="bpane-err">
            <span className="bpane-err-ic"><Icon name="shieldWarn" size={26} /></span>
            <div className="bpane-err-tt">{t("right.loadFailedTitle")}</div>
            <div className="bpane-err-sub">
              {t("right.loadFailedSub")}
            </div>
            <div className="bpane-err-acts">
              <button className="btn" onClick={retry}>{t("common.retry")}</button>
              <button className="btn" onClick={() => openExternal(current)}>{t("right.openExternalShort")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
