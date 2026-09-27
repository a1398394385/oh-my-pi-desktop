// 宿主级 MCP 连接池管理：支持全局共享（global）与项目级共享（project）
// 1. 引用计数机制：有会话挂载时 refCount++，会话 dispose 时 refCount--；
// 2. 闲置宽限回收（Idle TTL）：refCount 归零后启动 120 秒静止定时器，无新接入才平滑释放；
// 3. 安全沙箱隔离：全局共享实例在握手时不向服务端暴露工作区 roots 目录（空根）；
// 4. 环境与凭证哈希：连接池 Key 绑定有效 env 指纹，防止私有 Token 跨会话串用；
// 5. 软取消（Soft Cancel）：会话中止时发送 notifications/cancelled 协议消息，不暴力 Kill 共享进程。

import path from "node:path";
import { connectToServer, disconnectServer } from "./bootstrap.ts";
import { H } from "./state.ts";

export type McpSharingMode = "session" | "project" | "global";

export interface SharedMcpConnection {
  poolKey: string;
  serverName: string;
  sharing: "project" | "global";
  scopeKey: string; // "global" 或项目绝对路径 cwd
  envHash: string;
  connection: any; // MCPServerConnection
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  config: any;
  createdAt: number;
  lastActiveAt: number;
}

export interface SharedMcpStats {
  poolKey: string;
  serverName: string;
  sharing: "project" | "global";
  scopeKey: string;
  refCount: number;
  isIdle: boolean;
  idleRemainingMs?: number;
  uptimeMs: number;
}

// 闲置宽限时间：120 秒（2 分钟）
const IDLE_TTL_MS = 120_000;

// 全局内存池
const sharedPool = new Map<string, SharedMcpConnection>();
const connectingPromises = new Map<string, Promise<SharedMcpConnection>>();

/**
 * 计算共享连接池的复合唯一键
 * 结合作用域、服务名称和环境变量哈希，实现同凭证安全复用、不同凭证自动隔离
 */
export function computeMcpPoolKey(
  serverName: string,
  sharing: "project" | "global",
  scopeKey: string,
  env: Record<string, string> = {}
): string {
  const envStr = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  const envHash = (Bun as any).hash(envStr).toString(16);
  const scopePrefix = sharing === "global" ? "global" : `project:${path.resolve(scopeKey)}`;
  return `${scopePrefix}::${serverName}::${envHash}`;
}

/**
 * 获取或新建共享 MCP 连接
 */
export async function acquireSharedMcpConnection(params: {
  serverName: string;
  sharing: "project" | "global";
  scopeKey: string;
  config: any;
  env?: Record<string, string>;
}): Promise<{ connection: any; poolKey: string; release: () => void }> {
  const { serverName, sharing, scopeKey, config, env = {} } = params;
  const poolKey = computeMcpPoolKey(serverName, sharing, scopeKey, env);

  // 1. 已有就绪连接：直接命中并复用
  const existing = sharedPool.get(poolKey);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.refCount++;
    existing.lastActiveAt = Date.now();
    return {
      connection: existing.connection,
      poolKey,
      release: () => releaseSharedMcpConnection(poolKey),
    };
  }

  // 2. 正在并发建立中：合并 Promise
  const pending = connectingPromises.get(poolKey);
  if (pending) {
    const entry = await pending;
    entry.refCount++;
    entry.lastActiveAt = Date.now();
    return {
      connection: entry.connection,
      poolKey,
      release: () => releaseSharedMcpConnection(poolKey),
    };
  }

  // 3. 全新创建连接
  const connectPromise = (async (): Promise<SharedMcpConnection> => {
    // 组装连接配置
    const resolvedConfig: any = {
      ...config,
      env: { ...(config.env || {}), ...env },
    };

    // 全局共享实例安全沙箱：若是 global，工作目录指向公共根，且不声明 roots 能力
    if (sharing === "global") {
      resolvedConfig.cwd = H.agentDir;
    } else {
      resolvedConfig.cwd = scopeKey;
    }

    const testName = `shared_${sharing}_${serverName}`;
    const conn = await connectToServer(testName, resolvedConfig);

    const entry: SharedMcpConnection = {
      poolKey,
      serverName,
      sharing,
      scopeKey,
      envHash: poolKey.split("::").pop() || "",
      connection: conn,
      refCount: 1,
      idleTimer: null,
      config: resolvedConfig,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    // 监听连接断开：若当前仍有会话持有，触发透明断线重连
    if (conn.transport) {
      conn.transport.onClose = () => {
        const live = sharedPool.get(poolKey);
        if (live && live.refCount > 0) {
          process.stderr.write(`[mcp-pool] 共享连接 "${serverName}" 意外断开，正在就地透明重连...\n`);
          // 重新发起连接并在成功后换掉 connection 句柄
          void connectToServer(testName, resolvedConfig)
            .then((newConn) => {
              if (sharedPool.get(poolKey) === live) {
                live.connection = newConn;
                process.stderr.write(`[mcp-pool] 共享连接 "${serverName}" 透明重连成功\n`);
              } else {
                void disconnectServer(newConn).catch(() => {});
              }
            })
            .catch((err) => {
              process.stderr.write(`[mcp-pool] 共享连接 "${serverName}" 透明重连失败: ${err}\n`);
            });
        }
      };
    }

    sharedPool.set(poolKey, entry);
    return entry;
  })();

  connectingPromises.set(poolKey, connectPromise);

  try {
    const entry = await connectPromise;
    return {
      connection: entry.connection,
      poolKey,
      release: () => releaseSharedMcpConnection(poolKey),
    };
  } finally {
    connectingPromises.delete(poolKey);
  }
}

/**
 * 释放对共享 MCP 连接的引用
 * 引用计数减为 0 时进入 120 秒闲置计时，超时才关闭进程
 */
export function releaseSharedMcpConnection(poolKey: string): void {
  const entry = sharedPool.get(poolKey);
  if (!entry) return;

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastActiveAt = Date.now();

  if (entry.refCount === 0 && !entry.idleTimer) {
    entry.idleTimer = setTimeout(async () => {
      // 确认宽限期结束后仍无新接入
      const current = sharedPool.get(poolKey);
      if (current && current.refCount === 0) {
        sharedPool.delete(poolKey);
        try {
          await disconnectServer(current.connection);
          process.stderr.write(`[mcp-pool] 闲置超时(${IDLE_TTL_MS / 1000}s)，已安全关闭共享实例: ${current.serverName}\n`);
        } catch (err) {
          process.stderr.write(`[mcp-pool] 关闭共享实例出错: ${err}\n`);
        }
      }
    }, IDLE_TTL_MS);
  }
}

/**
 * 软取消指定请求（发送 notifications/cancelled，不强杀进程）
 */
export function softCancelSharedMcp(poolKey: string, requestId: string | number, reason = "用户中止生成"): void {
  const entry = sharedPool.get(poolKey);
  if (!entry || !entry.connection?.transport) return;
  try {
    const cancelMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason },
    }) + "\n";
    if (typeof (entry.connection.transport as any).sendRaw === "function") {
      (entry.connection.transport as any).sendRaw(cancelMsg);
    }
  } catch {}
}

/**
 * 获取当前所有共享实例的统计数据
 */
export function getSharedMcpStats(): SharedMcpStats[] {
  const now = Date.now();
  const list: SharedMcpStats[] = [];
  for (const entry of sharedPool.values()) {
    list.push({
      poolKey: entry.poolKey,
      serverName: entry.serverName,
      sharing: entry.sharing,
      scopeKey: entry.scopeKey,
      refCount: entry.refCount,
      isIdle: entry.refCount === 0,
      idleRemainingMs: entry.idleTimer ? Math.max(0, IDLE_TTL_MS - (now - entry.lastActiveAt)) : undefined,
      uptimeMs: now - entry.createdAt,
    });
  }
  return list;
}

/**
 * 宿主退出时优雅清理全部共享实例
 */
export async function closeAllSharedMcpConnections(): Promise<void> {
  const entries = Array.from(sharedPool.values());
  sharedPool.clear();
  for (const entry of entries) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await disconnectServer(entry.connection);
    } catch {}
  }
}
