// RPC 处理器签名：ws 为 Bun WS、msg 为 JSON.parse 后的请求体（any，边界处逐字段收窄）。
// 异常由 main.ts 分发壳统一捕获回 error 帧，处理器只管业务。
export type RpcHandler = (ws: any, msg: any) => void | Promise<void>;
