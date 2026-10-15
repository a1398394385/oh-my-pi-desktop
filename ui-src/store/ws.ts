// WS connection slice: ws/connected/connText, send, the connect retry loop, the stamped event
// guard, and the frame dispatch entry. All frame business handling lives in store/wsHandlers/
// (five-domain handler tables); heavy session-domain logic sank into store/session.ts, terminal
// frames are pushed straight to store/terminal.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { admitStampedEvent } from "./session";
import { dispatchFrame } from "./wsHandlers";
import { t } from "../i18n";
import type { HostFrame, HostRequest } from "../types/frames";

export interface WsSlice {
  ws: WebSocket | null;
  connected: boolean;
  connText: string;
  /** Timestamp of the first lost connection (or never connected); cleared to null on reconnect. ConnBanner uses it to measure the continuous failure duration */
  connFailSince: number | null;
  send(obj: HostRequest): void;
  setConnected(ok: boolean, text: string): void;
  connect(): Promise<void>;
}

export const createWsSlice: StateCreator<AppStore, [], [], WsSlice> = (set, get) => ({
  ws: null,
  connected: false,
  // Evaluated at module load, before initI18n() runs, so t() yields undefined
  // here — harmless: connect() (called after initI18n) overwrites it before
  // the first render.
  connText: t("notify.connecting"),
  connFailSince: null,

  send(obj: HostRequest): void {
    const ws = get().ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  },
  setConnected(ok: boolean, text: string): void {
    set((s) => ({
      connected: ok,
      connText: text,
      // Semantics = time elapsed since the last successful connection (counted from the first
      // connect when never connected); counting the >15s cold-start case is expected behavior:
      // after 30s without a connection the recovery surface should appear
      connFailSince: ok ? null : (s.connFailSince ?? Date.now()),
      // The shell is usable the moment the WS is up; the project pill shows the
      // label-only placeholder until session_list lands the default project.
      ...(ok && s.bootSplash ? { bootSplash: false } : {}),
    }));
  },
  async connect(): Promise<void> {
    if (!invoke) {
      get().setConnected(false, t("notify.noHost"));
      return;
    }
    get().setConnected(false, t("notify.connecting"));
    // Host cold start may take >15s (the model catalog refresh through a proxy blocks READY): a
    // ws_url failure doesn't give up; retry periodically until the port arrives (BUG-008: previously
    // surfaced as the profile menu degrading to a single fallback entry)
    let url: string;
    try {
      url = await invoke("ws_url");
    } catch (error) {
      get().setConnected(false, t("notify.hostStartFailed", { error: translateHostError(String(error)) }));
      scheduleReconnect(get().connect);
      return;
    }
    const ws = new WebSocket(url);
    set({ ws });
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onopen = () => {
      reconnectAttempt = 0;
      get().setConnected(true, t("notify.connected"));
      get().send({ type: "list_sessions" });
      // At startup the welcome page renders before the connection; get_git_branches was once dropped by send — refetch once connected
      if (get().isCreatingNew && get().newSessionProject) get().send({ type: "get_git_branches", cwd: get().newSessionProject });
      // Same drop-window refetch for the header branch chip (active session's cwd)
      const activePath = get().activePath;
      const activeCwd = activePath ? get().openSessions.get(activePath)?.cwd : undefined;
      if (activeCwd) get().send({ type: "get_git_branches", cwd: activeCwd });
      // If the settings page opened before the connection was ready, its data requests were dropped by send — refetch once connected
      if (get().settingsOpen) get().refreshSettingsData();
      // Resend the current UI locale unconditionally so a (re)started host
      // converges on the frontend's persisted language.
      get().send({ type: "set_locale", lang: get().uiPrefs.lang });
    };
    // Auto-reconnect after disconnect (3s) so the UI doesn't get permanently stuck in stale state during a host restart
    ws.onclose = () => {
      get().setConnected(false, t("notify.disconnected"));
      scheduleReconnect(get().connect);
    };
    ws.onerror = () => get().setConnected(false, t("notify.disconnected"));
  },
});

const reconnectDelays = [100, 250, 500, 1000, 2000, 3000];
let reconnectAttempt = 0;

// ---------- Host boot error code translation ----------
// The shell (src-tauri/src/lib.rs) reports host boot failures as stable
// "code" / "code: detail" strings. Map the prefix to a translated message
// and keep the dynamic detail; anything unrecognized passes through
// unchanged (older shells still send plain text).
const HOST_BOOT_ERRORS: Record<string, string> = {
  "asset-dir-failed": "misc.bootAssetDirFailed",
  "host-sidecar-missing": "misc.bootHostSidecarMissing",
  "host-spawn-failed": "misc.bootHostSpawnFailed",
  "host-exit-early": "misc.bootHostExitEarly",
  "host-restart-stopped": "misc.bootHostRestartStopped",
  "host-not-ready": "misc.bootHostNotReady",
  "notify-failed": "misc.bootNotifyFailed",
};

export function translateHostError(raw: string): string {
  for (const [code, key] of Object.entries(HOST_BOOT_ERRORS)) {
    if (raw === code) return t(key);
    if (raw.startsWith(code + ": ")) return `${t(key)}: ${raw.slice(code.length + 2)}`;
  }
  return raw;
}

function scheduleReconnect(connect: () => Promise<void>): void {
  const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
  reconnectAttempt += 1;
  setTimeout(() => void connect(), delay);
}

// Global object injected by the Tauri shell (absent in browser direct-connect debugging). invoke
// return shapes vary per command and event payloads are host/shell messages — both are real
// external boundaries: default to any, narrowed as needed at call sites.
declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke: <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      event?: { listen: (event: string, handler: (e: { payload?: any }) => void) => Promise<unknown> };
      window?: { getCurrentWindow(): import("./titlebar-window").TauriWindow };
    };
  }
}

export const invoke = window.__TAURI__?.core?.invoke;

// ---------- Frame dispatch entry ----------
// msg is a host WS frame; the entry's JSON.parse result is exactly the HostFrame discriminated
// union (types/frames mirrors sender-side construction).
// Unsolicited pushes carrying a position stamp pass the guard first (RPC replies without hi are
// unaffected), then go to the wsHandlers tables for dispatch.
function onMessage(msg: HostFrame): void {
  const stamped = msg as { hi?: string; seq?: number }; // stamp fields are carried by only some frames; the guard only reads them, never writes, so later discrimination is intact
  if (stamped.hi !== undefined && !admitStampedEvent(stamped)) return;
  dispatchFrame(msg);
}

// WKWebView has no console: report uncaught errors to the host log + toast
window.onerror = (msg, source, line, col, error) => {
  useAppStore.getState().toast(String(msg).slice(0, 120));
  useAppStore.getState().send({ type: "ui_error", message: formatUiError(String(msg), { source, line, col, error }) });
};
window.addEventListener("unhandledrejection", (e) => {
  useAppStore
    .getState()
    .send({ type: "ui_error", message: formatUiError(`unhandledrejection: ${String(e.reason)}`, { error: e.reason }) });
});

// The toast keeps the visible one-liner; the host log is the only forensic record a WKWebView
// leaves, so it must also carry where the error was thrown (source position) and the stack --
// without them a reported error cannot be located at all (the file:line in a minified bundle is
// not enough to find the throw site in source). Both are truncated: a deep component stack is
// worthless in a single log line and the host has no console to fall back on.
const UI_ERROR_STACK_LIMIT = 2000;
function formatUiError(
  msg: string,
  where: { source?: string; line?: number; col?: number; error?: unknown },
): string {
  const at = where.source ? ` @ ${where.source}:${where.line ?? 0}:${where.col ?? 0}` : "";
  const stack = where.error instanceof Error ? where.error.stack : undefined;
  return `${msg.slice(0, 300)}${at}${stack ? `\n${stack.slice(0, UI_ERROR_STACK_LIMIT)}` : ""}`;
}

export { onMessage };
