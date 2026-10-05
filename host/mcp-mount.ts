// Session-bound MCP mounting (pool-lifecycle edition): mounts pooled MCP
// connections into a pooled session's tool surface at pool boundaries only —
// session create / first history load / switch-back after frontend eviction —
// and releases them on frontend eviction (mcp_detach RPC), session delete or
// reload. No mid-session dynamic toggling by design.
//
// Connection sharing follows each server's configured level:
//   - global  → shared pool entry, one connection process-wide
//   - project → shared pool entry keyed by the session's cwd
//   - session → private connection owned by this entry alone
// Tools are minted via MCPTool.fromTools (canonical mcp__<server>_<tool>
// names) and pushed onto the tool surface with session.refreshMCPTools.
// MCP prompts/resources and the mcp:// device stay manager-bound and are NOT
// wired here (enableMCP stays false; OAuth-configured servers are unsupported
// — connectToServer has no auth storage on this path).
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPTool as McpToolInstance } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { connectToServer, disconnectServer, listTools, MCPTool } from "./bootstrap.ts";
import { acquireSharedMcpConnection } from "./mcp-pool.ts";
import { loadAllMcpScoped, type McpServerAsset } from "./assets.ts";
import { H, stampEvent, type PoolEntry } from "./state.ts";
import { safeStderr } from "./stderr.ts";

/** Registry entry shape (structure-compatible with capabilities.ts McpRuntimeStatus) */
interface MountedStatus {
  servers: { name: string; status: "connected" | "connecting" | "disconnected" }[];
  tools: number;
}

/** Per-session mount registry — the capabilities page's MCP data source */
const mountedRegistry = new Map<string, MountedStatus>();

/** Fenced generation check: true when the session was released/remounted mid-flight (7 lockstep call sites) */
const stale = (entry: PoolEntry, gen: number): boolean => entry.mcpMountGen !== gen;

function pushMcpFrame(sessionId: string, entry: PoolEntry): void {
  // Same narrowing pattern as state.ts stampEvent: attachedWs is unknown at the type level
  const ws = entry.attachedWs as { send(data: string): unknown } | null;
  if (!ws) return;
  const mounted = mountedRegistry.get(sessionId);
  ws.send(
    JSON.stringify(
      stampEvent({
        type: "capabilities_mcp",
        sessionId,
        mcp: mounted ?? { servers: [], tools: 0 },
      }),
    ),
  );
}

/** Capabilities snapshot source (capabilities.ts consumes this) */
export function mcpMountedSnapshot(sessionId: string): MountedStatus | undefined {
  return mountedRegistry.get(sessionId);
}

/** Visible set for a cwd: user-level config everywhere, project-level config only in its own project. sharing decides the connection reuse mode, not the visibility. */
function visibleMcpServers(servers: McpServerAsset[], cwd: string): McpServerAsset[] {
  const projectScope = `project:${cwd}`;
  return servers.filter((s) => s.enabled && (s.scope === "profile" || s.scope === projectScope));
}

/**
 * Warm the shared pool for a cwd before any session exists: acquire-then-release
 * each visible shared server so the connection sits pooled (the idle TTL then
 * owns its lifecycle — typing for over 2 minutes simply lets it be reclaimed,
 * degrading to the non-preloaded behavior). Session-level servers are skipped:
 * their connections are session-private and would be built for nobody.
 * When the session does arrive, mountMcpForSession hits the pool instead of
 * paying the connect.
 */
export async function preloadMcpForCwd(cwd: string): Promise<void> {
  let servers: McpServerAsset[];
  try {
    ({ servers } = await loadAllMcpScoped({ probe: false }));
  } catch (err) {
    safeStderr(`[mcp-mount] 预载可见集计算失败: ${err}\n`);
    return;
  }
  const shared = visibleMcpServers(servers, cwd).filter(
    (s) => s.sharing === "global" || s.sharing === "project",
  );
  const startedAt = Date.now();
  await Promise.all(
    shared.map(async (s) => {
      try {
        const { release } = await acquireSharedMcpConnection({
          serverName: s.name,
          sharing: s.sharing === "global" ? "global" : "project",
          scopeKey: s.sharing === "global" ? H.agentDir : cwd,
          config: toServerConfig(s, cwd),
        });
        release(); // refCount back to 0: the idle TTL now owns the connection
      } catch (err) {
        safeStderr(`[mcp-mount] 预载服务器 "${s.name}" 失败: ${err}\n`);
      }
    }),
  );
  safeStderr(`[mcp-mount] 预载完成 cwd=${cwd}: ${shared.length} 台共享服务器已入池(耗时 ${Date.now() - startedAt}ms)\n`);
}

/** Assemble the transport config for one server (union discriminant must be a literal) */
function toServerConfig(s: McpServerAsset, cwd: string): MCPServerConfig {
  if (s.transport === "http" || s.transport === "sse") {
    return { type: s.transport, url: s.url ?? "", headers: s.headers, cwd: s.cwd ?? cwd };
  }
  return { type: "stdio", command: s.command ?? "", args: s.args, env: s.env, cwd: s.cwd ?? cwd };
}

/**
 * Mount every MCP server visible to this session's cwd onto its tool surface.
 * Idempotent: an already-mounted session resolves immediately; concurrent
 * calls share the in-flight promise (no double mount). Fire-and-forget safe —
 * callers never await this on the pool-entry critical path; the prompt path
 * awaits it with a bounded race so the first request carries the full tool
 * surface (a mount landing between turns forks the prefix cache).
 */
export function mountMcpForSession(sessionId: string, entry: PoolEntry): Promise<void> {
  if (entry.mcpReleases.length > 0) return Promise.resolve(); // already mounted
  if (entry.mcpMountInFlight) return entry.mcpMountInFlight; // share the in-flight mount
  const promise = doMountMcpForSession(sessionId, entry).finally(() => {
    if (entry.mcpMountInFlight === promise) entry.mcpMountInFlight = undefined;
  });
  entry.mcpMountInFlight = promise;
  return promise;
}

async function doMountMcpForSession(sessionId: string, entry: PoolEntry): Promise<void> {
  const gen = ++entry.mcpMountGen;

  let servers: McpServerAsset[];
  try {
    ({ servers } = await loadAllMcpScoped({ probe: false }));
  } catch (err) {
    safeStderr(`[mcp-mount] 可见集计算失败: ${err}\n`);
    return;
  }
  if (stale(entry, gen)) return;

  const visible = visibleMcpServers(servers, entry.cwd);

  const tools: McpToolInstance[] = [];
  const statuses: MountedStatus["servers"] = [];
  const holds: Array<() => void> = [];

  for (const s of visible) {
    try {
      const config = toServerConfig(s, entry.cwd);
      let hold: () => void;
      let conn: MCPServerConnection;
      if (s.sharing === "global" || s.sharing === "project") {
        const acquired = await acquireSharedMcpConnection({
          serverName: s.name,
          sharing: s.sharing,
          scopeKey: s.sharing === "global" ? H.agentDir : entry.cwd,
          config,
        });
        conn = acquired.connection;
        hold = acquired.release;
      } else {
        // Session-private connection: the pool is bypassed entirely
        conn = await connectToServer(s.name, config);
        hold = () => {
          void disconnectServer(conn).catch(() => {});
        };
      }
      if (stale(entry, gen)) {
        hold();
        return;
      }

      const defs = await listTools(conn);
      if (stale(entry, gen)) {
        hold();
        return;
      }

      // Self-healing reconnect for stale connections: a fresh connection is
      // registered as an extra session hold (released on unmount), so it can
      // never leak. The dead pool entry cleans itself up through the pool's
      // own onClose/idle machinery.
      const reconnect = async () => {
        const fresh = await connectToServer(s.name, config);
        if (stale(entry, gen)) {
          void disconnectServer(fresh).catch(() => {});
        } else {
          entry.mcpReleases.push(() => {
            void disconnectServer(fresh).catch(() => {});
          });
        }
        return fresh;
      };

      tools.push(...MCPTool.fromTools(conn, defs, reconnect));
      statuses.push({ name: s.name, status: "connected" });
      holds.push(hold);
    } catch (err) {
      safeStderr(`[mcp-mount] 服务器 "${s.name}" 挂载失败: ${err}\n`);
      statuses.push({ name: s.name, status: "disconnected" });
    }
  }

  if (stale(entry, gen)) {
    for (const h of holds) h();
    return;
  }

  entry.mcpReleases.push(...holds);
  mountedRegistry.set(sessionId, { servers: statuses.sort((a, b) => a.name.localeCompare(b.name)), tools: tools.length });
  try {
    void entry.session.refreshMCPTools(tools);
  } catch (err) {
    safeStderr(`[mcp-mount] 工具面刷新失败: ${err}\n`);
  }
  if (!stale(entry, gen)) pushMcpFrame(sessionId, entry);
  if (tools.length || statuses.length) {
    safeStderr(`[mcp-mount] 会话 ${sessionId.slice(0, 8)} 挂载 ${statuses.length} 台 MCP 服务器 / ${tools.length} 个工具\n`);
  }
}

/**
 * Release every MCP reference held by this session and unmount its tool
 * surface. Idempotent; safe on never-mounted sessions.
 */
export function releaseMcpForSession(sessionId: string, entry: PoolEntry): void {
  entry.mcpMountGen++; // fence in-flight mounts from writing back
  entry.mcpMountInFlight = undefined; // a later mount must not share the fenced one
  const holds = entry.mcpReleases.splice(0);
  for (const h of holds) {
    try {
      h();
    } catch {}
  }
  if (!holds.length && !mountedRegistry.has(sessionId)) return;
  mountedRegistry.delete(sessionId);
  try {
    void entry.session.refreshMCPTools([]);
  } catch {}
  pushMcpFrame(sessionId, entry);
}
