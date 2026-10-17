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
  /** Remote-control takeover: the host kicked this connection (kicked frame or close code 4001). Gates all auto-reconnect — reconnect only via the manual "reclaim" action (Spec §7: any auto retry here revives the kick-fight loop) */
  kickedByOther: boolean;
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
  kickedByOther: false,

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
    get().setConnected(false, t("notify.connecting"));
    let url: string;
    if (REMOTE) {
      // Remote control: hit this origin's remote service directly; no key parks on the key-entry
      // placeholder instead of burning the retry ladder on guaranteed-401 connects
      const key = getRemoteKey();
      if (!key) {
        get().setConnected(false, t("notify.remoteNeedKey"));
        return;
      }
      url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?t=${encodeURIComponent(key)}`;
    } else {
      if (!invoke) {
        get().setConnected(false, t("notify.noHost"));
        return;
      }
      // Host cold start may take >15s (the model catalog refresh through a proxy blocks READY): a
      // ws_url failure doesn't give up; retry periodically until the port arrives (BUG-008: previously
      // surfaced as the profile menu degrading to a single fallback entry)
      try {
        url = await invoke("ws_url");
      } catch (error) {
        get().setConnected(false, t("notify.hostStartFailed", { error: translateHostError(String(error)) }));
        scheduleReconnect(get().connect);
        return;
      }
    }
    let everOpened = false;
    const ws = new WebSocket(url);
    set({ ws });
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onopen = () => {
      everOpened = true;
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
      // converges on the frontend's persisted language — local only: remote
      // browsers must not overwrite the host's locale (denylisted anyway;
      // sending it just toasted "remote read-only" on every load).
      if (!REMOTE) get().send({ type: "set_locale", lang: get().uiPrefs.lang });
    };
    // Auto-reconnect after disconnect (3s) so the UI doesn't get permanently stuck in stale state during a host restart.
    // Kicked by another client (remote-control takeover): NEVER auto-reconnect — the new holder would
    // kick us again, looping forever (Spec §7). Reconnect happens only via the manual reclaim action.
    ws.onclose = (ev) => {
      get().setConnected(false, t("notify.disconnected"));
      if (ev.code === 4001 || get().kickedByOther) {
        set({ kickedByOther: true });
        return;
      }
      // Remote handshake rejected before upgrade (host replied 401 to a stale/wrong key):
      // browsers surface it as an opaque 1006 — the real HTTP status is invisible to JS.
      // 1006 is also what "network down" looks like, so probe the static root: host alive
      // + handshake rejected = dead key, drop it and let ConnBanner's key-entry placeholder
      // take over; unreachable = transient, keep the retry ladder. Only for connections that
      // never opened — a dropped established connection stays on the plain retry path.
      if (REMOTE && ev.code === 1006 && !everOpened) {
        void fetch(`${location.origin}/?handshake-retry=${Date.now()}`, { cache: "no-store" })
          .then((res) => {
            if (res.ok) localStorage.removeItem(REMOTE_KEY_STORAGE);
            else scheduleReconnect(get().connect);
          })
          .catch(() => scheduleReconnect(get().connect));
        return;
      }
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

// ---------- Remote control mode (Spec §4.1) ----------
// REMOTE = plain browser against the host's remote LAN service: no Tauri shell, and not the
// ?preview=1 sample page (the preview check mirrors main.tsx, which also skips connect() there).
// The remote WS endpoint is this same origin's /ws gated by the access key.
export const REMOTE = !invoke && !new URLSearchParams(window.location.search).has("preview");

const REMOTE_KEY_STORAGE = "omp-remote-key";

// Key provenance: URL ?t= on first visit → persisted to localStorage → query wiped via
// replaceState so the key stops living in the address bar/history. Null means the user still
// has to enter it (ConnBanner renders the key-entry placeholder then).
export function getRemoteKey(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("t");
  if (fromUrl) {
    localStorage.setItem(REMOTE_KEY_STORAGE, fromUrl);
    window.history.replaceState(null, "", window.location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(REMOTE_KEY_STORAGE);
}

// ---------- Frame dispatch entry ----------
// msg is a host WS frame; the entry's JSON.parse result is exactly the HostFrame discriminated
// union (types/frames mirrors sender-side construction).
// Unsolicited pushes carrying a position stamp pass the guard first (RPC replies without hi are
// unaffected), then go to the wsHandlers tables for dispatch.
function onMessage(msg: HostFrame): void {
  // Takeover notice precedes the stamp guard: it carries no hi/seq and needs no dispatch — the
  // close(4001) that follows re-confirms it, either path alone sets the kicked gate
  if (msg.type === "kicked") {
    useAppStore.setState({ kickedByOther: true });
    return;
  }
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
