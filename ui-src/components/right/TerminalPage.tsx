// Right panel terminal page: xterm.js + host real PTY (pty-bridge subprocess, over the WS
// terminal.* channel).
// One terminal per conversation session (keyed by session path; the host multiplexes
// PTYs by frontend-supplied id). Session/tab switches only move the DOM (scrollback
// and running processes survive); closing the "Terminal" tab or deleting the session
// destroys that session's PTY.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, activeOpen, onTerminalFrame, useAppStore } from "../../store";
import type { TerminalFrame } from "../../store";
import { t } from "../../i18n";
import { registerTabCloseHook } from "./tabs";

// Right-panel tab-level persistentKey prefix; per-session ids are `key:<sessionPath>`
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

// ---------- Per-session terminals ----------
// Each session owns an independent PTY keyed by its session path (the host already
// multiplexes PTYs by frontend-supplied id). Switching sessions only moves DOM;
// closing the terminal tab or deleting the session destroys that session's PTY.
// Detached terminals of background sessions keep running (long commands survive
// a switch); they die with the app via the host's WS-disconnect cleanup.

// TermSession shape (fields per the comment list above)
interface TermSession {
  term: Terminal;
  fit: FitAddon;
  hostEl: HTMLDivElement;
  id: string; // frontend-generated, unique per session path
  ready: boolean; // terminal_created received (PTY accepts writes)
  dead: boolean;
  detached: boolean;
  lastDims: string;
  pendingWrites: string[];
  unsubFrame: (() => void) | null;
  ro: ResizeObserver | null;
  mo: MutationObserver | null;
  rafTimer: number | null;
}

const sessions = new Map<string, TermSession>(); // session path (or "welcome") -> terminal

/** Terminal id sent to the host: unique per session path. */
const termIdFor = (key: string) => `${PERSIST_KEY}:${key}`;

function fitAndResize(own: TermSession) {
  const { term, fit } = own;
  try { fit.fit(); } catch { return; }
  const dims = term.cols + "x" + term.rows;
  if (dims !== own.lastDims) {
    own.lastDims = dims;
    // PTY ready → send resize; when not ready the create frame carries the first-frame size, no top-up needed here
    if (own.ready && !own.dead) send({ type: "terminal_resize", id: own.id, cols: term.cols, rows: term.rows });
  }
}

function scheduleFit(own: TermSession) {
  if (own.rafTimer) return;
  own.rafTimer = requestAnimationFrame(() => {
    own.rafTimer = null;
    fitAndResize(own);
  });
}

function createTermSession(key: string, container: HTMLElement): TermSession {
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

  const own: TermSession = {
    term, fit, hostEl,
    id: termIdFor(key), ready: false, dead: false, detached: false,
    lastDims: term.cols + "x" + term.rows,
    pendingWrites: [],
    unsubFrame: null, ro: null, mo: null, rafTimer: null,
  };

  // PTY frames are routed by id: each session's subscription only consumes its own
  // created/data/exit frames (created = PTY ready, flush buffered input)
  own.unsubFrame = onTerminalFrame((frame: TerminalFrame) => {
    if (frame.id !== own.id) return;
    if (frame.type === "terminal_created") {
      own.ready = true;
      if (own.pendingWrites.length) {
        for (const d of own.pendingWrites) send({ type: "terminal_write", id: own.id, data: d });
        own.pendingWrites.length = 0;
      }
    } else if (frame.type === "terminal_data") {
      own.term.write(frame.data);
    } else if (frame.type === "terminal_exit") {
      own.dead = true;
      own.term.write(`\r\n\x1b[90m${t("right.procExited", { code: frame.code })}\x1b[0m\r\n`);
    }
  });

  // User input -> PTY (buffered until the PTY is ready; flushed at once after create)
  term.onData((data) => {
    if (own.ready && !own.dead) send({ type: "terminal_write", id: own.id, data });
    else own.pendingWrites.push(data);
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
  own.ro = new ResizeObserver(() => scheduleFit(own));
  own.ro.observe(container);

  // Theme hot-reload: follows data-theme switches (same idea as Zcode's MutationObserver)
  own.mo = new MutationObserver(() => {
    own.term.options.theme = buildTheme();
  });
  own.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
    id: own.id,
    cwd: s?.cwd || st.getAvailableProjects()[0]?.cwd || "",
    cols: term.cols,
    rows: term.rows,
    inheritProfile: inherit,
  });
  return own;
}

function ensureSession(container: HTMLElement, key: string) {
  const existing = sessions.get(key);
  if (existing) {
    // Reuse: move the DOM back into the new container (scrollback and processes survive)
    container.appendChild(existing.hostEl);
    existing.detached = false;
    scheduleFit(existing);
    return;
  }
  sessions.set(key, createTermSession(key, container));
}

// Component unmount only moves the DOM away to keep it alive; real destruction goes
// through the tab close hook or disposeSessionFor
function detachSession(key: string) {
  const own = sessions.get(key);
  if (!own || own.detached) return;
  own.detached = true;
  own.hostEl.remove();
}

/** Destroy the terminal owned by session `key` (tab close / session delete; PTY process reclaimed too). */
export function disposeSessionFor(key: string) {
  const own = sessions.get(key);
  if (!own) return;
  sessions.delete(key);
  if (!own.dead) send({ type: "terminal_dispose", id: own.id });
  own.unsubFrame?.();
  own.ro?.disconnect();
  own.mo?.disconnect();
  if (own.rafTimer) cancelAnimationFrame(own.rafTimer);
  try { own.term.dispose(); } catch {}
  own.hostEl.remove();
}

registerTabCloseHook("terminal", () => {
  // The close button is clicked in the current session's right panel context
  disposeSessionFor(useAppStore.getState().activePath || "welcome");
});

export default function TerminalPage() {
  const ref = useRef<HTMLDivElement | null>(null);
  // Terminal identity follows the active session: switching sessions swaps the
  // attached PTY (each session keeps its own scrollback and running processes)
  const key = useAppStore((st) => st.activePath || "welcome");
  useEffect(() => {
    const el = ref.current;
    if (el) ensureSession(el, key);
    return () => detachSession(key);
  }, [key]);
  return (
    <div className="tpane">
      <div className="tpane-host-wrap" ref={ref} />
    </div>
  );
}
