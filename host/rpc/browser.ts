// Browser mirror domain RPC: right-panel live view of the Agent's built-in
// browser. subscribe gates the CDP screencast stream (and re-applies on
// resize/reconnect — the host reconfigures maxWidth on every subscribe),
// select switches the mirrored tab, unsubscribe stops the stream,
// browser_input forwards UI mouse/keyboard into the mirrored page (CDP
// Input domain; interactive mirror).
// The 500ms registry poll itself is host-lifelong (browser_tabs pushes carry
// the activation edge for the UI's auto-open signal).
import {
	browserMirrorInput,
	browserMirrorSelect,
	browserMirrorSubscribe,
	browserMirrorUnsubscribe,
} from "../browser-mirror.ts";
import type { RpcHandler } from "./types";

export const browserHandlers: Record<string, RpcHandler> = {
  browser_mirror_subscribe(ws, msg) {
    const width = Number(msg.width);
    browserMirrorSubscribe(ws, { width: Number.isFinite(width) ? width : undefined });
  },
  browser_mirror_unsubscribe(_ws) {
    browserMirrorUnsubscribe();
  },
  browser_mirror_select(_ws, msg) {
    browserMirrorSelect(String(msg.name ?? ""));
  },
  browser_input(_ws, msg) {
    browserMirrorInput({
      name: String(msg.name ?? ""),
      op: msg.op === "wheel" || msg.op === "key" || msg.op === "text" ? msg.op : "mouse",
      action: msg.action === "up" || msg.action === "move" ? msg.action : "down",
      x: Number(msg.x),
      y: Number(msg.y),
      button: typeof msg.button === "string" ? msg.button : undefined,
      count: Number(msg.count),
      deltaX: Number(msg.deltaX),
      deltaY: Number(msg.deltaY),
      key: typeof msg.key === "string" ? msg.key : undefined,
      text: typeof msg.text === "string" ? msg.text : undefined,
    });
  },
};
