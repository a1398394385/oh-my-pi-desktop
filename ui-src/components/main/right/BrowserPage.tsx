// Right panel manual-browse page ("browser" tab): the original ZCode-style
// embedded iframe browser — address bar + sandboxed iframe + open-external
// fallback. The Agent live mirror (screencast) lives in MirrorPage.tsx
// ("mirror" tab); shared URL/key helpers are exported for it.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../../Icon";
import { invoke, toast, type TimerHandle } from "../../../store";
import { t } from "../../../i18n";

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
export function displayBrowserUrl(href: string): string {
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
export const SPECIAL_KEY_NAMES: Record<string, string> = {
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

export async function openExternal(url: string) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    toast(t("right.openLinkFailed", { err: String(err) }));
  }
}

export default function BrowserPage() {
  return <ManualBrowserView />;
}

// ---------- Manual browse view (original embedded iframe browser) ----------
function ManualBrowserView() {
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
      {/* Toolbar: back / forward / reload / address bar / open external / more */}
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
