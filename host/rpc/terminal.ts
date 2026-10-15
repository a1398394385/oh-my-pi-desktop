// Terminal domain RPC: create/write/resize/dispose of right-panel PTY terminals. Moved over from the main.ts message dispatch (third slice).
import { createTerminal, terminalFor } from "../pty.ts";
import type { RpcHandler } from "./types";

export const terminalHandlers: Record<string, RpcHandler> = {
  async terminal_create(ws, msg) {
    // Right-panel terminal: start a real PTY (the pty-bridge subprocess of
    // pty.ts), data frames pushed back.
    // The id comes from the frontend (tab-level persistentKey); onData may
    // arrive before create returns, so don't wait for the return value
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
