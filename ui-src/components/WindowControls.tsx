// Windows window controls (minimize/maximize/close) for the frameless window
// (decorations:false). No standalone title bar: the buttons blend into existing
// card headers — chat-head top-right when the right panel is collapsed, sp-head
// top-right when it is expanded (App.tsx / RightPanel.tsx gate both placement
// and IS_WINDOWS). macOS keeps the system Overlay + traffic lights, no render.
// Dragging and double-click maximize are handled by Tauri via the
// data-tauri-drag-region on the host headers (capabilities/default.json).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// withGlobalTauri-injected window API (the frontend does not bundle @tauri-apps/api).
// __TAURI__ global declaration lives in store/ws.ts (window typing: ./titlebar-window)
import type { TauriWindow } from "../store/titlebar-window";

function win(): TauriWindow {
  // Browser direct-debug (?preview=1, no Tauri injection): window controls are
  // meaningless, no-op keeps the component renderable
  return window.__TAURI__?.window?.getCurrentWindow() ?? {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  };
}

function MinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaxIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export default function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = win();
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then(setMaximized);
    void w.onResized(() => {
      void w.isMaximized().then(setMaximized);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title={t("misc.minimize")} onClick={() => void win().minimize()}>
        <MinIcon />
      </button>
      <button type="button" className="win-btn" title={maximized ? t("misc.restoreDown") : t("misc.maximize")} onClick={() => void win().toggleMaximize()}>
        {maximized ? <RestoreIcon /> : <MaxIcon />}
      </button>
      <button type="button" className="win-btn win-close" title={t("common.close")} onClick={() => void win().close()}>
        <CloseIcon />
      </button>
      {/* Invisible hit extension to the window's literal top-right corner: the host
         cards are inset by --shell-gap, so the corner itself would be a dead zone —
         Windows users slam the mouse there by muscle memory. Hover highlights the
         close button (CSS :has), click closes. Must stay no-drag (fixed-position
         descendant of the header's data-tauri-drag-region). */}
      <div className="win-hot" aria-hidden="true" onClick={() => void win().close()} />
    </div>
  );
}
