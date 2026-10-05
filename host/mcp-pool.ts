// Host-level MCP connection pool management: supports global sharing (global)
// and project-level sharing (project).
// 1. Reference counting: refCount++ when a session mounts, refCount-- when it disposes;
// 2. Idle grace recycling (Idle TTL): once refCount hits zero, a 120-second
//    quiet timer starts; only release smoothly when nothing new attaches;
// 3. Sandbox isolation: global shared instances never expose workspace roots
//    directories to the server during handshake (empty roots);
// 4. Env and credential hash: pool keys bind the effective env fingerprint,
//    preventing private tokens from leaking across sessions;
// 5. Soft cancel: on session abort, send a notifications/cancelled protocol
//    message instead of brutally killing the shared process.

import path from "node:path";
import { connectToServer, disconnectServer } from "./bootstrap.ts";
import { H } from "./state.ts";
import { hostI18n } from "../ui-src/i18n/host.ts";
import { safeStderr } from "./stderr.ts";

export type McpSharingMode = "session" | "project" | "global";

export interface SharedMcpConnection {
  poolKey: string;
  serverName: string;
  sharing: "project" | "global";
  scopeKey: string; // "global" or the project's absolute path cwd
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

// Idle grace period: 120 seconds (2 minutes)
const IDLE_TTL_MS = 120_000;

// Global in-memory pool
const sharedPool = new Map<string, SharedMcpConnection>();
const connectingPromises = new Map<string, Promise<SharedMcpConnection>>();

/**
 * Compute the composite unique key of a shared connection pool entry.
 * Combines scope, server name, and env hash so identical credentials are
 * safely reused while different credentials stay isolated automatically.
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
 * Acquire (or create) a shared MCP connection.
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

  // 1. Existing ready connection: hit and reuse directly
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

  // 2. Concurrently being established: merge onto the promise
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

  // 3. Create a brand-new connection
  const connectPromise = (async (): Promise<SharedMcpConnection> => {
    // Assemble the connection config
    const resolvedConfig: any = {
      ...config,
      env: { ...(config.env || {}), ...env },
    };

    // Security sandbox for global shared instances: when global, point the working directory at the common root and declare no roots capability
    if (sharing === "global") {
      resolvedConfig.cwd = H.agentDir;
    } else {
      resolvedConfig.cwd = scopeKey;
    }

    // The connection name IS the server name: MCPTool mints `mcp__<name>_<tool>`
    // from connection.name, so a synthetic prefix here would corrupt every
    // mounted tool's name.
    const conn = await connectToServer(serverName, resolvedConfig);

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

    // Watch for disconnects: if sessions still hold it, trigger transparent reconnect in place
    if (conn.transport) {
      conn.transport.onClose = () => {
        const live = sharedPool.get(poolKey);
        if (live && live.refCount > 0) {
          safeStderr(`[mcp-pool] 共享连接 "${serverName}" 意外断开，正在就地透明重连...\n`);
          // Re-connect and swap the connection handle once it succeeds
          void connectToServer(serverName, resolvedConfig)
            .then((newConn) => {
              if (sharedPool.get(poolKey) === live) {
                live.connection = newConn;
                safeStderr(`[mcp-pool] 共享连接 "${serverName}" 透明重连成功\n`);
              } else {
                void disconnectServer(newConn).catch(() => {});
              }
            })
            .catch((err) => {
              safeStderr(`[mcp-pool] 共享连接 "${serverName}" 透明重连失败: ${err}\n`);
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
 * Release a reference to a shared MCP connection.
 * When the reference count drops to zero, the 120-second idle countdown
 * starts; only the timeout closes the process.
 */
export function releaseSharedMcpConnection(poolKey: string): void {
  const entry = sharedPool.get(poolKey);
  if (!entry) return;

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastActiveAt = Date.now();

  if (entry.refCount === 0 && !entry.idleTimer) {
    entry.idleTimer = setTimeout(async () => {
      // Confirm nothing new attached after the grace period
      const current = sharedPool.get(poolKey);
      if (current && current.refCount === 0) {
        sharedPool.delete(poolKey);
        try {
          await disconnectServer(current.connection);
          safeStderr(`[mcp-pool] 闲置超时(${IDLE_TTL_MS / 1000}s)，已安全关闭共享实例: ${current.serverName}\n`);
        } catch (err) {
          safeStderr(`[mcp-pool] 关闭共享实例出错: ${err}\n`);
        }
      }
    }, IDLE_TTL_MS);
  }
}

/**
 * Soft-cancel a request (sends notifications/cancelled, no hard kill).
 */
export function softCancelSharedMcp(poolKey: string, requestId: string | number, reason = hostI18n.t("errors.mcp.userCancelled")): void {
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
 * Collect stats of all current shared instances.
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
 * Gracefully clean up all shared instances on host shutdown.
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
