// 终端域 RPC：右栏 PTY 终端的创建/写入/尺寸/释放。自 main.ts message 分发平移（第三刀）。
import { createTerminal, terminalFor } from "../pty.ts";
import type { RpcHandler } from "./types";

export const terminalHandlers: Record<string, RpcHandler> = {
  async terminal_create(ws, msg) {
    // 右栏终端：起真 PTY（pty.ts 的 pty-bridge 子进程），数据帧回推。
    // id 由前端生成（tab 级 persistentKey），create 前就可能收到 onData，故不能等返回值
    const id = String(msg.id ?? crypto.randomUUID());
    const cwd = String(msg.cwd ?? process.cwd()).trim() || process.cwd();
    const cols = Math.max(2, Math.min(500, Number(msg.cols) || 80));
    const rows = Math.max(2, Math.min(200, Number(msg.rows) || 24));
    const inheritProfile = msg.inheritProfile !== false;
    const session = await createTerminal(
      ws,
      { id, cwd, cols, rows, shell: msg.shell ? String(msg.shell) : undefined, inheritProfile },
      (data) => {
        try { ws.send(JSON.stringify({ type: "terminal_data", id, data })); } catch {}
      },
      (code) => {
        try { ws.send(JSON.stringify({ type: "terminal_exit", id, code })); } catch {}
      },
    );
    ws.send(JSON.stringify({ type: "terminal_created", id: session.id, shell: session.shell }));
  },
  terminal_write(ws, msg) {
    const t = terminalFor(ws, msg.id);
    if (t) t.send(String(msg.data ?? ""));
  },
  terminal_resize(ws, msg) {
    const t = terminalFor(ws, msg.id);
    if (t) t.resize(Math.max(2, Number(msg.cols) || 80), Math.max(2, Number(msg.rows) || 24));
  },
  terminal_dispose(ws, msg) {
    const t = terminalFor(ws, msg.id);
    if (t) t.dispose();
  },
};
