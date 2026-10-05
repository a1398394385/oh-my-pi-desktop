// Right panel terminal page: xterm.js + host real PTY (pty-bridge subprocess, over the WS
// terminal.* channel).
// Session lifecycle aligned with ZCode's sidePaneTerminalSessionRegistry: module-level
// singleton, tab switches only move the DOM (scrollback and running processes survive);
// closing the "Terminal" tab destroys the PTY via the tabs.js close hook.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, activeOpen, onTerminalFrame, useAppStore } from "../../store";
import type { TerminalFrame } from "../../store";
import { t } from "../../i18n";
import { registerTabCloseHook } from "./tabs";

// Right-panel tab-level persistentKey: only one terminal tab exists; the session is reused under this key
const PERSIST_KEY = "right-terminal";

// Terminal font stack (same idea as ZCode's DEFAULT_TERMINAL_FONT_FAMILY: monospace + Nerd Font fallback)
const TERM_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "MesloLGS NF", "Hack Nerd Font", monospace';

// ---------- Theme: CSS token -> xterm ITheme (dark/light ANSI palettes) ----------
const ANSI_DARK = {
  black: "#1c1c1e", red: "#ff6b68", green: "#34c759", yellow: "#febc2e",
  blue: "#6fb3d8", magenta: "#a86fe0", cyan: "#56c2c6", white: "#ededef",
  brightBlack: "#6e6e76", brightRed: "#ff8a86", brightGreen: "#46e06c", brightYellow: "#ffd25e",
  brightBlue: "#8cc7ea", brightMagenta: "#c08deb", brightCyan: "#6fdade", brightWhite: "#ffffff",
};
const ANSI_LIGHT = {
  black: "#3a3a3c", red: "#d05c52", green: "#2f9e44", yellow: "#b7791f",
  blue: "#2b6cb0", magenta: "#805ad5", cyan: "#2c7a7b", white: "#f6f6f8",
  brightBlack: "#8c8c92", brightRed: "#e07066", brightGreen: "#37b455", brightYellow: "#d69a2d",
  brightBlue: "#3f83c0", brightMagenta: "#9268dd", brightCyan: "#3a8f90", brightWhite: "#ffffff",
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme-mode") === "dark";
}
function buildTheme() {
  const dark = isDarkTheme();
  return {
    background: cssVar("--card"), // terminal background = right panel card base, blends into the panel
    foreground: cssVar("--text"),
    cursor: cssVar("--text"),
    cursorAccent: cssVar("--card"),
    selectionBackground: dark ? "rgba(74,158,255,.30)" : "rgba(10,120,220,.25)",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

// ---------- Module-level session singleton ----------
// Terminal frames use the store's TerminalFrame discriminated union (terminal_created/data/exit)

// Session singleton shape (field semantics per the comment list above)
interface TermSession {
  term: Terminal;
  fit: FitAddon;
  hostEl: HTMLDivElement;
  id: string | null;
  dead: boolean;
  detached: boolean;
  lastDims: string;
  pendingWrites: string[];
  unsubFrame: (() => void) | null;
  ro: ResizeObserver | null;
  mo: MutationObserver | null;
  rafTimer: number | null;
}

let session: TermSession | null = null;

function fitAndResize() {
  if (!session) return;
  const { term, fit } = session;
  try { fit.fit(); } catch { return; }
  const dims = term.cols + "x" + term.rows;
  if (dims !== session.lastDims) {
    session.lastDims = dims;
    // PTY ready → send resize; when not ready the create frame carries the first-frame size, no top-up needed here
    if (session.id && !session.dead) send({ type: "terminal_resize", id: session.id, cols: term.cols, rows: term.rows });
  }
}

function scheduleFit() {
  if (!session || session.rafTimer) return;
  session.rafTimer = requestAnimationFrame(() => {
    session!.rafTimer = null; // assertion: same as the original — throws as-is if the singleton was disposed (in practice the RAF fires first within the lifetime)
    fitAndResize();
  });
}

// Subscribe to PTY data frames (mounted once at session creation; the subscription lives with the singleton)
function bindFrameChannel() {
  session!.unsubFrame = onTerminalFrame((frame: TerminalFrame) => { // assertion: only called after ensureSession builds the singleton, non-null
    if (!session || frame.id !== session.id) return;
    if (frame.type === "terminal_data") {
      session.term.write(frame.data);
    } else if (frame.type === "terminal_exit") {
      session.dead = true;
      session.term.write(`\r\n\x1b[90m${t("right.procExited", { code: frame.code })}\x1b[0m\r\n`);
    }
  });
}

function ensureSession(container: HTMLElement) {
  if (session) {
    // Reuse: move the DOM back into the new container (scrollback and processes survive)
    container.appendChild(session.hostEl);
    session.detached = false;
    scheduleFit();
    return;
  }
  const customFont = useAppStore.getState().uiPrefs.terminalFont?.trim();
  const term = new Terminal({
    fontSize: 13,
    fontFamily: customFont || TERM_FONT,
    theme: buildTheme(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const hostEl = document.createElement("div");
  hostEl.className = "tpane-host";
  container.appendChild(hostEl);
  term.open(hostEl);
  fit.fit(); // synchronous first fit: the create frame carries the correct size, avoiding a startup-output/resize race

  session = {
    term, fit, hostEl,
    id: null, dead: false, detached: false,
    lastDims: term.cols + "x" + term.rows,
    pendingWrites: [],
    unsubFrame: null, ro: null, mo: null, rafTimer: null,
  };
  bindFrameChannel();

  // User input -> PTY (buffered until the PTY is ready; flushed at once after create)
  term.onData((data) => {
    // assertion: onData is registered while the singleton lives, so session is non-null when the callback fires (same as the original)
    if (session!.id && !session!.dead) send({ type: "terminal_write", id: session!.id, data });
    else session!.pendingWrites.push(data);
  });

  // Clipboard: ⌘/Ctrl+C copies when there's a selection; ⌘/Ctrl+V pastes manually (prevents double writes)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "c" || e.key === "C") && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    if (mod && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
      return false;
    }
    return true;
  });

  // Container size change -> fit -> resize frame (RAF-coalesced; dragging the width doesn't thrash)
  session.ro = new ResizeObserver(scheduleFit);
  session.ro.observe(container);

  // Theme hot-reload: follows data-theme switches (same idea as ZCode's MutationObserver)
  session.mo = new MutationObserver(() => {
    if (!session) return;
    session.term.options.theme = buildTheme();
  });
  session.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Start the PTY: cwd takes the current active session's project directory, falling
  // back to the primary project (getAvailableProjects()[0], same convention as new-session
  // defaults) when no session is open. An empty cwd would make the host fall back to its
  // own process.cwd(), which for a GUI-spawned host is the arbitrary launch dir (usually
  // the home dir) — not a project-centric default.
  const s = activeOpen();
  const st = useAppStore.getState();
  const inherit = st.uiPrefs.terminalInheritProfile !== false;
  send({
    type: "terminal_create",
    id: PERSIST_KEY,
    cwd: s?.cwd || st.getAvailableProjects()[0]?.cwd || "",
    cols: term.cols,
    rows: term.rows,
    inheritProfile: inherit,
  });
}

// Component unmount only moves the DOM away to keep it alive; real destruction goes through the tab close hook
function detachSession() {
  if (!session || session.detached) return;
  session.detached = true;
  session.hostEl.remove();
}

// Destroy: triggered by the tabs.js hook when the "Terminal" tab closes (PTY process reclaimed too)
function disposeSession() {
  if (!session) return;
  const st = session;
  session = null;
  if (st.id && !st.dead) send({ type: "terminal_dispose", id: st.id });
  st.unsubFrame?.();
  st.ro?.disconnect();
  st.mo?.disconnect();
  if (st.rafTimer) cancelAnimationFrame(st.rafTimer);
  try { st.term.dispose(); } catch {}
  st.hostEl.remove();
}

registerTabCloseHook("terminal", disposeSession);

// PTY-ready reply (terminal_created routed via the terminal frame bus bypass, see store.onMessage):
// record the session id, flush user input buffered during session creation
onTerminalFrame((frame: TerminalFrame) => {
  if (frame.type === "terminal_created" && session && !session.id) {
    session.id = frame.id;
    if (session.pendingWrites.length) {
      for (const d of session.pendingWrites) send({ type: "terminal_write", id: frame.id, data: d });
      session.pendingWrites.length = 0;
    }
  }
});

export default function TerminalPage() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) ensureSession(el);
    return () => detachSession();
  }, []);
  return (
    <div className="tpane">
      <div className="tpane-host-wrap" ref={ref} />
    </div>
  );
}
