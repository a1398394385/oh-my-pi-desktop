// Code-owned builtin MCP servers: defined here, never written to or read from
// the user-editable mcp.json. A same-named user entry in mcp.json is shadowed
// by the builtin definition on purpose — the computer-use provider chain must
// not depend on (or be breakable from) user config.
//
// Builtin servers are deliberately NOT part of the pool-boundary visible set
// (visibleMcpServers in mcp-mount.ts): sessions never auto-mount them. They
// mount mid-session only (the composer computer-use toggle, computer-mode.ts)
// and can be warmed into the shared pool ahead of time (warmBuiltinServer —
// provider picked / boot with the provider already picked). The asset's
// enabled:false is the belt-and-suspenders guard for that invariant.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServerAsset } from "./mcp-assets.ts";
import { acquireSharedMcpConnection } from "./mcp-pool.ts";
import { H } from "./state.ts";
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

/** MCP server name the Kimi computer-use provider drives */
export const KIMI_CU_SERVER = "kimi-cu";
const KIMI_CU_APP = "KimiCU.app";

/**
 * Candidate kimi-cu binary paths for this platform (macOS: /Applications and
 * ~/Applications bundles; Windows: the %LOCALAPPDATA%\KimiCU per-user install).
 */
function kimiCuBinaryCandidates(): string[] {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return [
      path.join(localAppData, "KimiCU", "kimi-cu.exe"),
      path.join(localAppData, "Programs", "KimiCU", "kimi-cu.exe"),
    ];
  }
  return ["/Applications", path.join(homedir(), "Applications")].map((root) =>
    path.join(root, KIMI_CU_APP, "Contents", "MacOS", "kimi-cu"),
  );
}

/** Resolved kimi-cu binary path when KimiCU is installed, else undefined. */
export function kimiCuBinaryPath(): string | undefined {
  for (const bin of kimiCuBinaryCandidates()) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/** Whether the KimiCU app is present on this machine (gates the provider option and every enable). */
export function kimiCuInstalled(): boolean {
  return kimiCuBinaryPath() !== undefined;
}

/** Builtin server definition for a name, else undefined. The command is resolved from the live install at every call. */
export function builtinServerAsset(name: string): McpServerAsset | undefined {
  if (name !== KIMI_CU_SERVER) return undefined;
  const bin = kimiCuBinaryPath();
  if (!bin) return undefined;
  return {
    name,
    transport: "stdio",
    command: bin,
    args: ["mcp", "-s", "user"],
    enabled: false, // never auto-mounted at pool boundaries; see the file header
    source: { provider: "builtin", providerName: "omp-desktop", path: "", level: "user" },
    scope: "profile",
    status: "disabled",
    sharing: "global",
  };
}

/**
 * Warm the shared pool for a builtin server: acquire-then-release the global
 * connection so it sits pooled and the idle TTL owns its lifecycle afterwards
 * (same pattern as preloadMcpForCwd). Doubles as the connection probe for the
 * settings page's test button. Returns false when the server is not installed
 * or the connect/list fails (details on stderr).
 */
export async function warmBuiltinServer(name: string): Promise<boolean> {
  const server = builtinServerAsset(name);
  if (!server) {
    safeStderr(hostI18n.t("errors.mcpBuiltin.warmNotBuiltin", { name }));
    return false;
  }
  try {
    const { release } = await acquireSharedMcpConnection({
      serverName: name,
      sharing: "global",
      scopeKey: H.agentDir,
      config: { type: "stdio", command: server.command, args: server.args },
    });
    release(); // refCount back to 0: the idle TTL now owns the connection
    safeStderr(hostI18n.t("errors.mcpBuiltin.warmed", { name }));
    return true;
  } catch (err) {
    safeStderr(hostI18n.t("errors.mcpBuiltin.warmFailed", { name, detail: String(err) }));
    return false;
  }
}
