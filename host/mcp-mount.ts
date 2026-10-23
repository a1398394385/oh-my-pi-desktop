// Session-bound MCP mounting (pool-lifecycle edition): mounts pooled MCP
// connections into a pooled session's tool surface at pool boundaries only —
// session create / first history load / switch-back after frontend eviction —
// and releases them on frontend eviction (mcp_detach RPC), session delete or
// reload. One deliberate exception: the computer-use provider toggle mounts a
// single named server (kimi-cu) mid-session, see mountServerForSession below.
//
// Tool ownership is tracked per server per session (sessionMounts): the pool
// boundary and mid-session paths mint tools into the same map, so every
// refreshMCPTools call can rebuild the full surface and a mid-session unmount
// can surgically drop one server's tools without touching the rest.
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
import { loadAllMcpScoped, type McpServerAsset } from "./mcp-assets.ts";
import { builtinServerAsset } from "./mcp-builtin.ts";
import { H, stampEvent, type PoolEntry } from "./state.ts";
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

/** Registry entry shape (structure-compatible with capabilities.ts McpRuntimeStatus) */
interface MountedStatus {
  servers: { name: string; status: "connected" | "connecting" | "disconnected" }[];
  tools: number;
}

/** One mounted server's tool instances plus its connection hold */
interface ServerMount {
  tools: McpToolInstance[];
  release: () => void;
}

/** Per-session mount registry — the capabilities page's MCP data source */
const mountedRegistry = new Map<string, MountedStatus>();

/**
 * Per-session, per-server tool ownership: the single source of truth for
 * rebuilding a session's full MCP tool surface on any refresh. The pool
 * boundary repopulates it wholesale; the mid-session computer-use toggle
 * adds/removes one named server inside it.
 */
const sessionMounts = new Map<string, Map<string, ServerMount>>();

function flattenMounts(mounts: Map<string, ServerMount>): McpToolInstance[] {
  const tools: McpToolInstance[] = [];
  for (const m of mounts.values()) tools.push(...m.tools);
  return tools;
}

/** Replace/insert one server's registry row and recompute the tool count from the live surface */
function upsertRegistry(sessionId: string, name: string, status: "connected" | "disconnected"): void {
  const mounts = sessionMounts.get(sessionId);
  const servers = (mountedRegistry.get(sessionId)?.servers ?? []).filter((s) => s.name !== name);
  servers.push({ name, status });
  servers.sort((a, b) => a.name.localeCompare(b.name));
  mountedRegistry.set(sessionId, { servers, tools: mounts ? flattenMounts(mounts).length : 0 });
}

/** Fenced generation check: true when the session was released/remounted mid-flight (7 lockstep call sites) */
const stale = (entry: PoolEntry, gen: number): boolean => entry.mcpMountGen !== gen;

function pushMcpFrame(sessionId: string, entry: PoolEntry): void {
  if (entry.uiSockets.size === 0) return;
  const mounted = mountedRegistry.get(sessionId);
  const data = JSON.stringify(
    stampEvent({
      type: "capabilities_mcp",
      sessionId,
      mcp: mounted ?? { servers: [], tools: 0 },
    }),
  );
  for (const ws of entry.uiSockets) ws.send(data);
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
    safeStderr(hostI18n.t("errors.mcpMount.preloadVisibleFailed", { detail: String(err) }));
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
        safeStderr(hostI18n.t("errors.mcpMount.preloadServerFailed", { name: s.name, detail: String(err) }));
      }
    }),
  );
  safeStderr(hostI18n.t("errors.mcpMount.preloadDone", { cwd, servers: shared.length, ms: Date.now() - startedAt }));
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
    safeStderr(hostI18n.t("errors.mcpMount.visibleFailed", { detail: String(err) }));
    return;
  }
  if (stale(entry, gen)) return;

  const visible = visibleMcpServers(servers, entry.cwd);

  const statuses: MountedStatus["servers"] = [];
  const holds: Array<() => void> = [];
  // Per-server ownership rebuilt by this pass. Mid-session mounts of servers
  // this pass does NOT cover (e.g. the disabled-until-toggled kimi-cu) are
  // carried over so the final surface refresh cannot drop them; a server this
  // pass DOES mount replaces its carried entry (old hold released in the loop).
  const carried = new Map(sessionMounts.get(sessionId) ?? []);
  const fresh = new Map<string, ServerMount>();

  for (const s of visible) {
    // A carried entry under the same name is superseded by this fresh mount
    const prev = carried.get(s.name);
    if (prev) {
      carried.delete(s.name);
      try {
        prev.release();
      } catch {}
    }
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

      const minted = MCPTool.fromTools(conn, defs, reconnect);
      fresh.set(s.name, { tools: minted, release: hold });
      statuses.push({ name: s.name, status: "connected" });
      holds.push(hold);
    } catch (err) {
      safeStderr(hostI18n.t("errors.mcpMount.mountFailed", { name: s.name, detail: String(err) }));
      statuses.push({ name: s.name, status: "disconnected" });
    }
  }

  if (stale(entry, gen)) {
    for (const h of holds) h();
    return;
  }

  entry.mcpReleases.push(...holds);
  sessionMounts.set(sessionId, new Map([...carried, ...fresh]));
  const surface = flattenMounts(sessionMounts.get(sessionId)!);
  mountedRegistry.set(sessionId, { servers: statuses.sort((a, b) => a.name.localeCompare(b.name)), tools: surface.length });
  // refreshMCPTools returns a promise: an async rejection escapes a sync
  // try/catch, so observe it with .catch() instead of try { void ... } catch.
  entry.session.refreshMCPTools(surface).catch((err) => {
    safeStderr(hostI18n.t("errors.mcpMount.refreshFailed", { detail: String(err) }));
  });
  if (!stale(entry, gen)) pushMcpFrame(sessionId, entry);
  if (surface.length || statuses.length) {
    safeStderr(hostI18n.t("errors.mcpMount.mounted", { sessionId: sessionId.slice(0, 8), servers: statuses.length, tools: surface.length }));
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
  // Mid-session server mounts (the computer-use toggle): release their holds
  // and drop their tool ownership alongside the pool-boundary mounts
  const mounts = sessionMounts.get(sessionId);
  if (mounts) {
    for (const m of mounts.values()) {
      try {
        m.release();
      } catch {}
    }
    sessionMounts.delete(sessionId);
  }
  if (!holds.length && !mounts && !mountedRegistry.has(sessionId)) return;
  mountedRegistry.delete(sessionId);
  entry.session.refreshMCPTools([]).catch((err) => {
    safeStderr(`[mcp-mount] unmount refresh failed for session ${sessionId.slice(0, 8)}: ${err}\n`);
  });
  pushMcpFrame(sessionId, entry);
}

/** Whether a named server is currently mounted into this session's tool surface (mid-session or pool boundary) */
export function isServerMounted(sessionId: string, name: string): boolean {
  return sessionMounts.get(sessionId)?.has(name) ?? false;
}

/**
 * Mid-session mount of a single named server (the computer-use provider
 * toggle). Builtin servers (mcp-builtin.ts) resolve from code and shadow any
 * same-named user mcp.json entry; everything else resolves from the visible
 * config set. This path deliberately ignores the server's enabled flag for
 * config-set servers too: kimi-cu used to be written to mcp.json disabled so
 * it never auto-mounted, and only opt-in sessions light it up. Idempotent per
 * session; connection sharing follows the server's configured level exactly
 * like the pool boundary. Returns false when the server is not resolvable
 * for this cwd or the connect/list fails (details on stderr).
 */
export async function mountServerForSession(sessionId: string, entry: PoolEntry, name: string): Promise<boolean> {
  let perSession = sessionMounts.get(sessionId);
  if (perSession?.has(name)) return true;
  let server: McpServerAsset | undefined = builtinServerAsset(name);
  if (!server) {
    let servers: McpServerAsset[];
    try {
      ({ servers } = await loadAllMcpScoped({ probe: false }));
    } catch (err) {
      safeStderr(hostI18n.t("errors.mcpMount.midMountVisibleFailed", { detail: String(err) }));
      return false;
    }
    const projectScope = `project:${entry.cwd}`;
    server = servers.find((s) => s.name === name && (s.scope === "profile" || s.scope === projectScope));
  }
  if (!server) return false;
  try {
    const config = toServerConfig(server, entry.cwd);
    let hold: () => void;
    let conn: MCPServerConnection;
    if (server.sharing === "global" || server.sharing === "project") {
      const acquired = await acquireSharedMcpConnection({
        serverName: name,
        sharing: server.sharing,
        scopeKey: server.sharing === "global" ? H.agentDir : entry.cwd,
        config,
      });
      conn = acquired.connection;
      hold = acquired.release;
    } else {
      conn = await connectToServer(name, config);
      hold = () => {
        void disconnectServer(conn).catch(() => {});
      };
    }
    const defs = await listTools(conn);
    const minted = MCPTool.fromTools(conn, defs);
    perSession = perSession ?? new Map();
    perSession.set(name, { tools: minted, release: hold });
    sessionMounts.set(sessionId, perSession);
    upsertRegistry(sessionId, name, "connected");
    entry.session.refreshMCPTools(flattenMounts(perSession)).catch((err) => {
      safeStderr(`[mcp-mount] mid-session mount refresh failed for session ${sessionId.slice(0, 8)}: ${err}\n`);
    });
    pushMcpFrame(sessionId, entry);
    safeStderr(hostI18n.t("errors.mcpMount.midMounted", { sessionId: sessionId.slice(0, 8), name, tools: minted.length }));
    return true;
  } catch (err) {
    safeStderr(hostI18n.t("errors.mcpMount.midMountFailed", { name, detail: String(err) }));
    upsertRegistry(sessionId, name, "disconnected");
    pushMcpFrame(sessionId, entry);
    return false;
  }
}

/**
 * Mid-session unmount of a single named server: releases its connection hold
 * and removes only its tools from the surface (every other mounted server
 * keeps its tools). Returns false when the server was not mounted.
 */
export function unmountServerForSession(sessionId: string, entry: PoolEntry, name: string): boolean {
  const perSession = sessionMounts.get(sessionId);
  const mount = perSession?.get(name);
  if (!perSession || !mount) return false;
  perSession.delete(name);
  try {
    mount.release();
  } catch {}
  upsertRegistry(sessionId, name, "disconnected");
  entry.session.refreshMCPTools(flattenMounts(perSession)).catch((err) => {
    safeStderr(`[mcp-mount] unmount "${name}" refresh failed for session ${sessionId.slice(0, 8)}: ${err}\n`);
  });
  pushMcpFrame(sessionId, entry);
  return true;
}
