// Dock terminal page: xterm.js + host real PTY (pty-bridge subprocess, over the WS
// terminal.* channel).
// One terminal PER TAB (right panel: one panel tab per terminal; bottom dock: one tab per
// terminal in its own head) keyed by (dock scope, session path, tab id) — the host
// multiplexes PTYs by frontend-supplied id. Session/tab switches only move the DOM
// (scrollback and running processes survive); closing a terminal tab or deleting the
// session destroys that tab's PTY.
// The bottom dock renders the same page under its own scope, so the dock and the right
// panel hold independent PTYs for the same session (IDE-style: two shells, not one
// mirrored view).
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, activeOpen, onTerminalFrame, useAppStore } from "../../../store";
import type { TerminalFrame } from "../../../store";
import { t } from "../../../i18n";
import { registerTabCloseHook, terminalTabId } from "./tabs";
import { registerSlotDisposer } from "../../../store/right";
import { registerTermTabDisposer, cycleTermTab, termOwnerKey, forgetRightTermTab } from "./termTabs";

// Host PTY id prefix; the rest is `scope:sessionPath:tabId`
const PERSIST_KEY = "right-terminal";

// Terminal font stack (same idea as ZCode's DEFAULT_TERMINAL_FONT_FAMILY: monospace + Nerd Font fallback)
const TERM_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "MesloLGS NF", "Hack Nerd Font", monospace';

/** Create the Terminal and mount it with xterm's DOM char-size strategy (see the comment below). */
function newTerminal(hostEl: HTMLElement, fontSize: number, fontFamily: string): Terminal {
  const opts = {
    fontSize,
    fontFamily,
    theme: buildTheme(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
  };
  // OffscreenCanvas is typed as an always-present global, but it is a configurable property that
  // this helper temporarily hides; the optional-shaped view is the only way TS accepts `delete`.
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas };
  // WKWebView's canvas 2D does not see user-installed fonts (~/Library/Fonts): for a font like
  // Fira Code, measureText("W") returns the default sans metrics (13px -> 12.27) while the DOM
  // measures the real advance (8.0). xterm v6 decides its char-size strategy inside open() and
  // prefers the OffscreenCanvas one, so the wrong 12.27 became the cell width; the DOM renderer
  // then padded every glyph up to that width (letter-spacing 4.27px) — vscode-like wide letter
  // spacing, and ~35% fewer columns. Hiding OffscreenCanvas across the constructor + open() call
  // makes CharSizeService fall back to its DOM measure element, which reads the font correctly.
  const saved = g.OffscreenCanvas;
  try {
    delete g.OffscreenCanvas;
    const term = new Terminal(opts);
    term.open(hostEl);
    return term;
  } finally {
    if (saved) g.OffscreenCanvas = saved;
  }
}

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
    selectionBackground: `color-mix(in srgb, ${cssVar("--accent")} ${dark ? 30 : 25}%, transparent)`,
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
  id: string; // frontend-generated, unique per (scope, session path, tab)
  key: string; // map key (`${scope}:${sessionPath}:${tab}`)
  scope: string; // dock scope ("right" | "bottom")
  tab: string; // tab id inside that scope
  ready: boolean; // terminal_created received (PTY accepts writes)
  dead: boolean;
  detached: boolean;
  lastDims: string;
  pendingWrites: string[];
  unsubFrame: (() => void) | null;
  ro: ResizeObserver | null;
  mo: MutationObserver | null;
  rafTimer: number | null;
  mouseGuard: (() => void) | null; // unhooks the mouseup-loss self-heal listeners
}

const sessions = new Map<string, TermSession>(); // `${scope}:${sessionPath}:${tab}` -> terminal
// Font pref hot-reload: the settings page writes terminalFont/terminalFontSize
// into uiPrefs; apply them to every live session (including detached ones) and
// re-fit so rows/cols follow the new metrics. Subscribe stays read-only (no
// setState inside — the React 19 store subscription contract).
useAppStore.subscribe((s, prev) => {
  if (s.uiPrefs.terminalFont === prev.uiPrefs.terminalFont
    && s.uiPrefs.terminalFontSize === prev.uiPrefs.terminalFontSize) return;
  const family = s.uiPrefs.terminalFont?.trim() || TERM_FONT;
  const size = s.uiPrefs.terminalFontSize ?? 13;
  for (const own of sessions.values()) {
    own.term.options.fontFamily = family;
    own.term.options.fontSize = size;
    scheduleFit(own);
  }
});


/** Terminal id sent to the host: unique per dock scope and session path. */
const termIdFor = (key: string) => `${PERSIST_KEY}:${key}`;

/** Map/host key for one dock scope: the right-sidebar tab and the bottom dock must not
 *  share an xterm instance (one DOM host) nor a PTY id. Tab ids join the key so each tab
 *  of a dock owns an independent PTY for the same session. */
const sessionKey = (scope: string, owner: string, tab: string) => `${scope}:${owner}:${tab}`;

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

function createTermSession(key: string, container: HTMLElement, scope: string, tab: string): TermSession {
  const st0 = useAppStore.getState();
  const customFont = st0.uiPrefs.terminalFont?.trim();
  const hostEl = document.createElement("div");
  hostEl.className = "tpane-host";
  container.appendChild(hostEl);
  const term = newTerminal(hostEl, st0.uiPrefs.terminalFontSize ?? 13, customFont || TERM_FONT);
  const fit = new FitAddon();
  term.loadAddon(fit);
  fit.fit(); // synchronous first fit: the create frame carries the correct size, avoiding a startup-output/resize race

  const own: TermSession = {
    term, fit, hostEl,
    id: termIdFor(key), key, scope, tab,
    ready: false, dead: false, detached: false,
    lastDims: term.cols + "x" + term.rows,
    pendingWrites: [],
    unsubFrame: null, ro: null, mo: null, rafTimer: null, mouseGuard: null,
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
    // Ctrl+Tab: xterm would otherwise forward Tab as input; the global binding never sees
    // the event (xterm stops propagation), so cycle the dock's tabs here too
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      cycleTermTab(e.shiftKey ? -1 : 1);
      return false;
    }
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

  // macOS WKWebView intermittently drops the mouseup that follows a terminal mousedown
  // (trackpad clicks especially). xterm then keeps its document-level mousemove listener
  // armed — and that handler ignores event.buttons — so every later hover grows a
  // selection from the stale click position. Self-heal: pair mousedown/mouseup ourselves;
  // a hover with no button held while a click is still unpaired replays a synthetic
  // mouseup so xterm ends the phantom drag.
  let clickUnpaired = false;
  const onDown = (e: MouseEvent) => { if (e.button === 0) clickUnpaired = true; };
  const onUp = () => { clickUnpaired = false; };
  const onHover = (e: MouseEvent) => {
    if (!clickUnpaired || e.buttons !== 0) return;
    clickUnpaired = false;
    e.target?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  };
  hostEl.addEventListener("mousedown", onDown);
  document.addEventListener("mouseup", onUp);
  hostEl.addEventListener("mousemove", onHover);
  own.mouseGuard = () => {
    hostEl.removeEventListener("mousedown", onDown);
    document.removeEventListener("mouseup", onUp);
    hostEl.removeEventListener("mousemove", onHover);
  };

  // Container size change -> fit -> resize frame (RAF-coalesced; dragging the width doesn't thrash)
  own.ro = new ResizeObserver(() => scheduleFit(own));
  own.ro.observe(container);

  // Theme hot-reload: follows data-theme switches (same idea as Zcode's MutationObserver)
  own.mo = new MutationObserver(() => {
    own.term.options.theme = buildTheme();
  });
  own.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Start the PTY: cwd takes the current active session's project directory; with
  // no session open (welcome page) it follows the project picked in the welcome
  // project selector (newSessionProject), falling back to the primary project
  // (getAvailableProjects()[0]). An empty cwd would make the host fall back to its
  // own process.cwd(), which for a GUI-spawned host is the arbitrary launch dir
  // (usually the home dir) — not a project-centric default.
  const s = activeOpen();
  const st = useAppStore.getState();
  const inherit = st.uiPrefs.terminalInheritProfile !== false;
  send({
    type: "terminal_create",
    id: own.id,
    cwd: s?.cwd || st.newSessionProject || st.getAvailableProjects()[0]?.cwd || "",
    cols: term.cols,
    rows: term.rows,
    inheritProfile: inherit,
  });
  return own;
}

function ensureSession(container: HTMLElement, key: string, ownerPath: string, scope: string, tab: string) {
  const existing = sessions.get(key);
  if (existing) {
    // Reuse: move the DOM back into the new container (scrollback and processes survive)
    container.appendChild(existing.hostEl);
    existing.detached = false;
    scheduleFit(existing);
    return;
  }
  const own = createTermSession(key, container, scope, tab);
  sessions.set(key, own);
  // Tie this PTY's lifetime to the session's right-panel slot (slot disposal cascades:
  // session delete / disk gone / LRU trim / profile switch). Registered exactly once
  // per created session (reuse branch above skips it), and re-registered if the
  // session is ever recreated after disposal. The slot always exists by now: session
  // activation and the welcome view materialize it (restoreRightSlot). Both dock scopes
  // AND every tab register on the same slot, so a session delete reclaims all PTYs.
  // Shared terminals are project-scoped: they outlive any one session and die only when
  // their tab is closed (or the app exits).
  if (!ownerPath.startsWith("p:")) registerSlotDisposer(ownerPath, () => disposeSessionFor(key));
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
  own.mouseGuard?.();
  own.ro?.disconnect();
  own.mo?.disconnect();
  if (own.rafTimer) cancelAnimationFrame(own.rafTimer);
  try { own.term.dispose(); } catch {}
  own.hostEl.remove();
}

// Destroy every PTY a tab owns (tab close / dock tab close). Sessions that ran the tab keep
// their process until the tab is closed, so one tab can span several sessions.
function disposeTermTab(scope: string, tab: string): void {
  for (const [key, own] of [...sessions]) {
    if (own.scope === scope && own.tab === tab) disposeSessionFor(key);
  }
}

registerTermTabDisposer(disposeTermTab);
registerTabCloseHook("terminal", (name) => {
  disposeTermTab("right", terminalTabId(name));
  forgetRightTermTab(name);
});

export default function TerminalPage({ scope = "right", tabId }: { scope?: string; tabId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const owner = useAppStore((st) => termOwnerKey(st.activePath || "welcome"));
  // Terminal identity follows (session, tab): switching either swaps the attached PTY
  // (each keeps its own scrollback and running processes)
  const key = sessionKey(scope, owner, tabId);
  // Key captured at mount: focusing below runs once when the tab opens, not on later
  // session switches (those must not steal focus from the chat composer)
  const keyAtMount = useRef(key);
  // Tab switches are an explicit user action, so they do take focus; session switches
  // do not (see above) and must not re-focus either
  const tabAtMount = useRef(tabId);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    ensureSession(el, key, owner, scope, tabId);
    return () => detachSession(key);
  }, [key, owner, scope, tabId]);
  // Declared after the effect above so the session exists in the map on mount.
  // Focus is pure DOM (works before terminal_created): typing works immediately —
  // input sent before the PTY is ready is buffered (pendingWrites) and flushed then.
  useEffect(() => {
    sessions.get(keyAtMount.current)?.term.focus();
  }, []);
  useEffect(() => {
    if (tabAtMount.current === tabId) return;
    tabAtMount.current = tabId;
    sessions.get(key)?.term.focus();
  }, [tabId, key]);
  return (
    <div className="tpane" data-scope={scope}>
      <div className="tpane-host-wrap" ref={ref} />
    </div>
  );
}
