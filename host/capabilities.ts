// Session capabilities domain: aggregates the runtime state of the subsystems attached to a
// pooled session — MCP connections, LSP servers, advisor, memory backend, extensions — into one
// snapshot for the right-panel capabilities page (get_capabilities RPC), and forwards MCP
// connection-status events as incremental frames. MCP and LSP are process-wide (shared by every
// session); advisor / memory / extensions are per-session. All state sources are read-only SDK
// accessors routed through bootstrap.ts (load-order contract).

import { H, type PoolEntry } from "./state.ts";
import { getLspStatus, createSessionMemoryRuntimeContext } from "./bootstrap.ts";
import { mcpMountedSnapshot } from "./mcp-mount.ts";

/** Narrow structural view of MCPManager the snapshot reads (the SDK manager satisfies it) */
interface McpManagerView {
  getAllServerNames(): string[];
  getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
  getTools(): unknown[];
}

/** Per-server MCP connection status (getConnectionStatus tri-state) */
export interface McpServerStatusEntry {
  name: string;
  status: "connected" | "connecting" | "disconnected";
}

/** Process-global MCP runtime view (the capabilities_mcp incremental frame body) */
export interface McpRuntimeStatus {
  servers: McpServerStatusEntry[];
  tools: number; // total loaded MCP tools — per-server split is unreliable (names are lossy-sanitized)
}

/** Serializable view of the base MemoryBackendStatus (host-owned contract, JSON boundary) */
export interface MemoryStatusView {
  backend: string;
  active: boolean;
  writable?: boolean;
  searchable?: boolean;
  scope?: string;
  workingCount?: number;
  episodicCount?: number;
  tripleCount?: number;
  lastMemory?: string;
  database?: string;
  message?: string;
  error?: string;
}

/** Full snapshot body of the capabilities reply frame */
export interface CapabilitiesSnapshot {
  sessionId: string;
  mcp: McpRuntimeStatus;
  lsp: { name: string; status: string; fileTypes?: string[]; error?: string }[];
  advisor: {
    configured: boolean;
    active: boolean;
    model?: string;
    contextWindow: number;
    contextTokens: number;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    messages: { user: number; assistant: number; total: number };
    advisors: { name: string; status: string; model?: string; cost: number; tokensTotal: number; messagesTotal: number }[];
  };
  memory: MemoryStatusView;
  extensions: {
    loaded: boolean;
    paths: string[];
    tools: string[];
    commands: string[];
    diagnostics: { type: string; message: string; path: string }[];
  };
}

const modelLabel = (m: unknown): string | undefined => {
  if (!m || typeof m !== "object" || !("provider" in m) || !("id" in m)) return undefined;
  const label = `${String(m.provider)}/${String(m.id)}`;
  return label === "/" ? undefined : label;
};

/** Read the manager's full connection state (a fresh read beats replaying incremental events) */
export function snapshotMcp(mcpManager: McpManagerView): McpRuntimeStatus {
  return {
    servers: mcpManager
      .getAllServerNames()
      .sort()
      .map((name) => ({ name, status: mcpManager.getConnectionStatus(name) })),
    tools: mcpManager.getTools().length,
  };
}

async function memoryStatus(entry: PoolEntry): Promise<MemoryStatusView> {
  try {
    return await createSessionMemoryRuntimeContext(entry.session, H.agentDir, entry.cwd).status();
  } catch (err) {
    // The backend may fail to resolve (broken install / unreachable DB): surface it instead of failing the whole snapshot
    return { backend: "off", active: false, writable: false, searchable: false, error: String(err) };
  }
}

export async function buildCapabilitiesSnapshot(entry: PoolEntry, sessionId: string): Promise<CapabilitiesSnapshot> {
  const session = entry.session;
  const mcpManager = entry.sessionResult?.mcpManager;
  const advisor = session.getAdvisorStats();
  const runner = session.extensionRunner;
  return {
    sessionId, // echo the pool key the frontend holds (≠ the base's internal session id)
    mcp: mcpMountedSnapshot(sessionId) ?? { servers: [], tools: 0 },
    lsp: getLspStatus().map((s) => ({ name: s.name, status: s.status, fileTypes: s.fileTypes, error: s.error })),
    advisor: {
      configured: advisor.configured,
      active: advisor.active,
      model: modelLabel(advisor.model),
      contextWindow: advisor.contextWindow,
      contextTokens: advisor.contextTokens,
      tokens: advisor.tokens,
      cost: advisor.cost,
      messages: advisor.messages,
      advisors: advisor.advisors.map((a) => ({
        name: a.name,
        status: a.status,
        model: modelLabel(a.model),
        cost: a.cost,
        tokensTotal: a.tokens.total,
        messagesTotal: a.messages.total,
      })),
    },
    memory: await memoryStatus(entry),
    extensions: runner
      ? {
          loaded: true,
          paths: runner.getExtensionPaths(),
          tools: runner.getAllRegisteredTools().map((t) => t.definition.name),
          commands: [
            ...session.slashCommands.map((c) => c.name),
            ...session.customCommands.map((c) => c.command.name),
          ],
          diagnostics: runner.getCommandDiagnostics(),
        }
      : { loaded: false, paths: [], tools: [], commands: [], diagnostics: [] },
  };
}
