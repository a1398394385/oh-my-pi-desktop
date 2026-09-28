// WS 连接 slice：ws/connected/connText、send、connect 重试环、stamped event 守卫
// 与帧分发入口。全帧业务处理在 store/wsHandlers/（五域处理器表）；
// session 域重逻辑下沉 store/session.ts，终端帧直推 store/terminal.ts。
import type { StateCreator } from "zustand";
import type { AppStore } from "./index";
import { useAppStore } from "./index";
import { admitStampedEvent } from "./session";
import { dispatchFrame } from "./wsHandlers";
import type { HostFrame } from "../types/frames";

export interface WsSlice {
  ws: WebSocket | null;
  connected: boolean;
  connText: string;
  /** 首次失去连接（或从未连上）的时刻；恢复连接清 null。ConnBanner 据此判定持续失败时长 */
  connFailSince: number | null;
  send(obj: unknown): void;
  setConnected(ok: boolean, text: string): void;
  connect(): Promise<void>;
}

export const createWsSlice: StateCreator<AppStore, [], [], WsSlice> = (set, get) => ({
  ws: null,
  connected: false,
  connText: "连接中…",
  connFailSince: null,

  send(obj: unknown): void {
    const ws = get().ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  },
  setConnected(ok: boolean, text: string): void {
    set((s) => ({
      connected: ok,
      connText: text,
      // 语义 = 距上次成功连接经过的时间（从未连上则从首次 connect 起算），
      // 冷启动 >15s 的情况计入是预期行为：30s 仍连不上就该给恢复面
      connFailSince: ok ? null : (s.connFailSince ?? Date.now()),
    }));
  },
  async connect(): Promise<void> {
    if (!invoke) {
      get().setConnected(false, "无宿主");
      return;
    }
    get().setConnected(false, "连接中…");
    // 宿主冷启动可能 >15s(模型目录走代理刷新阻塞 READY):ws_url 失败不放弃,
    // 周期重试直到拿到端口(BUG-008:曾表现为 profile 菜单 fallback 单项)
    let url: string;
    try {
      url = await invoke("ws_url");
    } catch (error) {
      get().setConnected(false, `宿主启动失败：${String(error)}`);
      scheduleReconnect(get().connect);
      return;
    }
    const ws = new WebSocket(url);
    set({ ws });
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onopen = () => {
      reconnectAttempt = 0;
      get().setConnected(true, "已连接");
      get().send({ type: "list_sessions" });
      // 启动时欢迎页先于连接渲染，get_git_branches 曾被 send 丢弃；连接就绪后补拉
      if (get().isCreatingNew && get().newSessionProject) get().send({ type: "get_git_branches", cwd: get().newSessionProject });
      // 设置页若在连接就绪前打开，4 个数据请求被 send 丢弃；连接就绪后补拉
      if (get().settingsOpen) get().refreshSettingsData();
    };
    // 断线后自动重连(3s),宿主重启期间 UI 不至于永久停留在旧状态
    ws.onclose = () => {
      get().setConnected(false, "已断开");
      scheduleReconnect(get().connect);
    };
    ws.onerror = () => get().setConnected(false, "已断开");
  },
});

const reconnectDelays = [100, 250, 500, 1000, 2000, 3000];
let reconnectAttempt = 0;

function scheduleReconnect(connect: () => Promise<void>): void {
  const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
  reconnectAttempt += 1;
  setTimeout(() => void connect(), delay);
}

// Tauri 壳注入的全局对象（浏览器直连调试时不存在）。invoke 返回形状随命令而异、
// event 载荷为宿主/壳消息，均为真实外部边界：默认 any，调用点按需收窄。
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

// ---------- 帧分发入口 ----------
// msg 为宿主 WS 帧;入口 JSON.parse 结果即 HostFrame 判别联合(types/frames 镜像发送端构造)。
// 带位置戳的主动推送先过守卫（RPC 响应无 hi 不受影响），再交 wsHandlers 表分发。
function onMessage(msg: HostFrame): void {
  const stamped = msg as { hi?: string; seq?: number }; // 戳字段仅部分帧携带,守卫只读不写,不破坏后续判别
  if (stamped.hi !== undefined && !admitStampedEvent(stamped)) return;
  dispatchFrame(msg);
}

// WKWebView 无 console：未捕获错误上报宿主日志 + toast
window.onerror = (msg) => {
  useAppStore.getState().toast(String(msg).slice(0, 120));
  useAppStore.getState().send({ type: "ui_error", message: String(msg).slice(0, 300) });
};
window.addEventListener("unhandledrejection", (e) => {
  useAppStore.getState().send({ type: "ui_error", message: "unhandledrejection: " + String(e.reason).slice(0, 300) });
});

export { onMessage };
