// RPC 处理器汇总与分发。九域 handler 表合并；未知命令回 error 帧（对齐旧 switch
// default）。异常由 main.ts 的 message 壳统一捕获回 error 帧。
// 穷尽性由 scripts/check-capabilities.mjs 的 RPC 清单登记守卫（94 个 method 逐一
// 可解析），handler 表的键集与清单一致。
import { sessionHandlers } from "./session";
import { promptHandlers } from "./prompt";
import { filesHandlers } from "./files";
import { modelsHandlers } from "./models";
import { settingsHandlers } from "./settings";
import { loginHandlers } from "./login";
import { assetsHandlers } from "./assets";
import { terminalHandlers } from "./terminal";
import { limitsHandlers } from "./limits";
import type { RpcHandler } from "./types";
import hostI18n from "../../ui-src/i18n/host";

export const rpcHandlers: Record<string, RpcHandler> = {
  ...sessionHandlers,
  ...promptHandlers,
  ...filesHandlers,
  ...modelsHandlers,
  ...settingsHandlers,
  ...loginHandlers,
  ...assetsHandlers,
  ...terminalHandlers,
  ...limitsHandlers,
};

/** 单命令分发：查表调用，未知命令回 error（旧 switch default 语义） */
export function dispatchRpc(ws: any, msg: any): void | Promise<void> {
  const h = rpcHandlers[msg.type as string];
  if (!h) {
    ws.send(JSON.stringify({ type: "error", message: hostI18n.t("errors.unknownCommand", { type: msg.type }) }));
    return;
  }
  return h(ws, msg);
}
