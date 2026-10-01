// 右栏终端页：xterm.js + 宿主真 PTY（pty-bridge 子进程，经 WS terminal.* 通道）。
// 会话生命周期对齐 ZCode sidePaneTerminalSessionRegistry：模块级单例，tab 切换只挪
// DOM（scrollback 与在跑进程不丢）；关「终端」tab 时经 tabs.js 关闭钩子销毁 PTY。
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, activeOpen, onTerminalFrame, useAppStore } from "../../store";
import type { TerminalFrame } from "../../store";
import { t } from "../../i18n";
import { registerTabCloseHook } from "./tabs";

// 右栏 tab 级 persistentKey：右栏只有一个终端 tab，会话按此键复用
const PERSIST_KEY = "right-terminal";

// 终端字体栈（ZCode DEFAULT_TERMINAL_FONT_FAMILY 同款思路：等宽 + Nerd Font 兜底）
const TERM_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "MesloLGS NF", "Hack Nerd Font", monospace';

// ---------- 主题：CSS token -> xterm ITheme（dark/light 两套 ANSI 调色板） ----------
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
  return document.documentElement.getAttribute("data-theme") !== "light";
}
function buildTheme() {
  const dark = isDarkTheme();
  return {
    background: cssVar("--card"), // 终端底色 = 右栏卡片底，融进面板
    foreground: cssVar("--text"),
    cursor: cssVar("--text"),
    cursorAccent: cssVar("--card"),
    selectionBackground: dark ? "rgba(74,158,255,.30)" : "rgba(10,120,220,.25)",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

// ---------- 模块级会话单例 ----------
// 终端帧用 store 的 TerminalFrame 判别联合(terminal_created/data/exit)

// 会话单例形状（字段语义见上方注释清单）
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
    // PTY 建好发 resize；没建好时 create 帧会带上首帧尺寸，这里不再补
    if (session.id && !session.dead) send({ type: "terminal_resize", id: session.id, cols: term.cols, rows: term.rows });
  }
}

function scheduleFit() {
  if (!session || session.rafTimer) return;
  session.rafTimer = requestAnimationFrame(() => {
    session!.rafTimer = null; // 断言：与原版一致——单例已 dispose 时此处原样抛错（实际生命周期内 RAF 先消费）
    fitAndResize();
  });
}

// 订阅 PTY 数据帧（会话创建时挂一次，订阅存活期跟随单例）
function bindFrameChannel() {
  session!.unsubFrame = onTerminalFrame((frame: TerminalFrame) => { // 断言：仅 ensureSession 建单例后调用，非空
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
    // 复用：DOM 挪回新容器（scrollback 与进程不丢）
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
  fit.fit(); // 首帧同步 fit：create 帧直接带正确尺寸，避免启动输出与尺寸校正竞态

  session = {
    term, fit, hostEl,
    id: null, dead: false, detached: false,
    lastDims: term.cols + "x" + term.rows,
    pendingWrites: [],
    unsubFrame: null, ro: null, mo: null, rafTimer: null,
  };
  bindFrameChannel();

  // 用户输入 -> PTY（PTY 未建好先缓冲，create 后一次 flush）
  term.onData((data) => {
    // 断言：onData 注册于单例存活期，回调触发时 session 必非空（与原版一致）
    if (session!.id && !session!.dead) send({ type: "terminal_write", id: session!.id, data });
    else session!.pendingWrites.push(data);
  });

  // 剪贴板：⌘/Ctrl+C 有选区时复制；⌘/Ctrl+V 手动粘贴（防双写）
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

  // 容器尺寸变化 -> fit -> resize 帧（RAF 合并，拖动调宽不刷屏）
  session.ro = new ResizeObserver(scheduleFit);
  session.ro.observe(container);

  // 主题热更新：跟随 data-theme 切换（ZCode MutationObserver 同款思路）
  session.mo = new MutationObserver(() => {
    if (!session) return;
    session.term.options.theme = buildTheme();
  });
  session.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // 起 PTY：cwd 取当前激活会话的项目目录
  const s = activeOpen();
  const inherit = useAppStore.getState().uiPrefs.terminalInheritProfile !== false;
  send({
    type: "terminal_create",
    id: PERSIST_KEY,
    cwd: s?.cwd ?? "",
    cols: term.cols,
    rows: term.rows,
    inheritProfile: inherit,
  });
}

// 组件卸载只挪走 DOM 保活；真正销毁走 tab 关闭钩子
function detachSession() {
  if (!session || session.detached) return;
  session.detached = true;
  session.hostEl.remove();
}

// 销毁：关「终端」tab 时由 tabs.js 钩子触发（PTY 进程一并回收）
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

// PTY 建好回包（terminal_created 经终端帧总线旁路路由，见 store.onMessage）：
// 记下会话 id，flush 建会话期间缓冲的用户输入
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
