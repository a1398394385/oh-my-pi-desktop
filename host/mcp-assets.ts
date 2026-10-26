// MCP asset domain: server discovery/merging across profile and each desktop
// project, stdio/http health probes with a 60s cache. Split out of assets.ts;
// depends only on the path leaf (asset-paths.ts).
import path from "node:path";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { hostI18n } from "./i18n/host.ts";
import { H } from "./state.ts";
import {
  loadCapability,
  clearCapabilityFsCache,
  connectToServer,
  disconnectServer,
  readDisabledServers,
  readEnabledServers,
} from "./bootstrap.ts";
import { getMcpSharingConfig } from "./profile.ts";
import { safeStderr } from "./stderr.ts";
import { validDesktopProjects, nearestProjectOmpDir } from "./asset-paths.ts";

// MCP health probe cache (avoids re-connecting within 60s). This used to live
// inside the listAgentAssets function body, which left server-layer
// set_mcp_server_enabled / test_mcp_server references dangling (TS2304) —
// hoisted to module level during the split.
export const mcpHealthCache = new Map<
  string,
  { status: "connected" | "error"; error?: string; log?: string; timestamp: number }
>();

async function probeStdioMcp(server: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}, timeoutMs = 5000): Promise<{ status: "connected" | "error"; error?: string; log?: string }> {
  const cmd = server.command?.trim();
  if (!cmd) {
    return {
      status: "error",
      error: hostI18n.t("flows.mcp.noCommand"),
      log: hostI18n.t("flows.mcp.noCommandLog"),
    };
  }
  const fullCmd = [cmd, ...(server.args ?? [])];
  const cwd = server.cwd && fs.existsSync(server.cwd) ? server.cwd : process.cwd();
  const env = { ...process.env, ...(server.env ?? {}) };

  let proc: any;
  try {
    proc = (Bun as any).spawn(fullCmd, {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: any) {
    const detail = err?.stack || err?.message || String(err);
    const errorMsg = hostI18n.t("flows.mcp.spawnFailed", { message: err?.message || String(err) });
    const log =
      hostI18n.t("flows.mcp.logCommand", { command: fullCmd.join(" ") }) +
      "\n" +
      hostI18n.t("flows.mcp.logCwd", { cwd }) +
      "\n" +
      hostI18n.t("flows.mcp.spawnFailLog", { detail });
    return { status: "error", error: errorMsg, log };
  }

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];

  const readStderr = async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {}
  };
  const stderrPromise = readStderr();

  const readStdout = async (): Promise<boolean> => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          stdoutChunks.push(line);
          try {
            const parsed = JSON.parse(line);
            if (parsed && (parsed.id === 1 || parsed.result)) {
              return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  };
  const stdoutPromise = readStdout();

  try {
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-desktop-probe", version: "1.0.0" },
      },
    }) + "\n";
    proc.stdin.write(new TextEncoder().encode(initMsg));
    await proc.stdin.flush();
  } catch {}

  let success = false;
  let timedOut = false;
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([
    stdoutPromise.then((ok) => { if (ok) success = true; }),
    proc.exited.then(() => {}),
    timeoutPromise,
  ]);

  try {
    if (success) {
      try {
        const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
        proc.stdin.write(new TextEncoder().encode(notif));
        await proc.stdin.flush();
      } catch {}
    }
    proc.kill();
  } catch {}

  // SIGTERM is not enough: some stdio MCP servers (python-based ones such as
  // mcp-atlassian) ignore it and keep running, so `exited` would never settle.
  // The probe feed the whole agent_assets frame through Promise.all, so one hung
  // server stalls the entire list. Bound the wait, then escalate to SIGKILL.
  if (!timedOut) {
    const grace = Promise.withResolvers<boolean>();
    const graceTimer = setTimeout(() => grace.resolve(false), 500);
    const exited = await Promise.race([proc.exited.then(() => true).catch(() => true), grace.promise]);
    clearTimeout(graceTimer);
    if (!exited) {
      try { proc.kill(9); } catch {}
      const hard = Promise.withResolvers<void>();
      const hardTimer = setTimeout(() => hard.resolve(), 500);
      await Promise.race([proc.exited.catch(() => {}), hard.promise]);
      clearTimeout(hardTimer);
    }
  }

  await Promise.race([stderrPromise, new Promise((r) => setTimeout(r, 200))]);

  const stderrText = stderrChunks.join("").trim();
  const stdoutText = stdoutChunks.join("\n").trim();
  const exitCode = proc.exitCode;

  if (success) {
    return { status: "connected" };
  }

  let summary = "";
  if (timedOut) {
    summary = hostI18n.t("flows.mcp.timedOut", { sec: timeoutMs / 1000 });
  } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    summary = hostI18n.t("flows.mcp.abnormalExit", { code: exitCode });
  } else if (stderrText) {
    summary = stderrText.split("\n")[0].slice(0, 120) || hostI18n.t("flows.mcp.outputAbnormal");
  } else {
    summary = hostI18n.t("flows.mcp.noJsonrpc");
  }

  const logLines = [
    hostI18n.t("flows.mcp.logCommand", { command: fullCmd.join(" ") }),
    hostI18n.t("flows.mcp.logCwd", { cwd }),
    hostI18n.t("flows.mcp.logExitCode", {
      code: exitCode ?? (timedOut ? hostI18n.t("flows.mcp.exitRunning") : hostI18n.t("flows.mcp.exitUnknown")),
    }),
  ];
  if (stderrText) {
    logLines.push(hostI18n.t("flows.mcp.logStderr", { text: stderrText }));
  }
  if (stdoutText) {
    logLines.push(hostI18n.t("flows.mcp.logStdout", { text: stdoutText }));
  }
  if (!stderrText && !stdoutText) {
    logLines.push(hostI18n.t("flows.mcp.logNoOutput", { ms: timeoutMs }));
  }

  return {
    status: "error",
    error: summary,
    log: logLines.join("\n"),
  };
}

export async function probeMcpServerHealth(server: {
  name: string;
  transport?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ status: "connected" | "error"; error?: string; log?: string }> {
  const cached = mcpHealthCache.get(server.name);
  if (cached && Date.now() - cached.timestamp < 60_000) {
    return { status: cached.status, error: cached.error, log: cached.log };
  }

  const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");

  if (transport === "stdio") {
    const res = await probeStdioMcp(server);
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }

  const config: any = {
    type: transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    cwd: server.cwd,
  };
  try {
    const conn = await Promise.race([
      connectToServer(`probe_${Date.now()}_${server.name}`, config),
      // Structured timeout marker: matched by MCP_TIMEOUT below, never by
      // display text — the branch must survive language switches.
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MCP_TIMEOUT")), 5000)
      ),
    ]);
    await disconnectServer(conn);
    const res = { status: "connected" as const };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  } catch (err: any) {
    let msg = err?.message || String(err);
    if (msg.includes("protocol") || msg.includes("version") || msg.includes("negotiation") || msg.includes("UnsupportedProtocolVersion")) {
      msg = hostI18n.t("flows.mcp.protocolFail");
    } else if (msg.includes("ECONNREFUSED")) {
      msg = hostI18n.t("flows.mcp.connRefused");
    } else if (msg.includes("MCP_TIMEOUT")) {
      msg = hostI18n.t("flows.mcp.connTimedOut");
    }
    const detail = err?.stack || err?.message || String(err);
    const log =
      hostI18n.t("flows.mcp.logUrl", { url: server.url || hostI18n.t("flows.mcp.urlUnknown") }) +
      "\n" +
      hostI18n.t("flows.mcp.logTransport", { transport }) +
      "\n" +
      hostI18n.t("flows.mcp.logReason", { reason: msg }) +
      "\n" +
      hostI18n.t("flows.mcp.logDetail", { detail });
    const res = { status: "error" as const, error: msg, log };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }
}

export interface McpServerAsset {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  source: {
    provider: string;
    providerName: string;
    path: string;
    level: "user" | "project" | "native";
  };
  scope: string; // "profile" | `project:${cwd}`
  projectName?: string;
  status: "connected" | "error" | "disabled" | "unknown";
  error?: string;
  log?: string;
  sharing?: "session" | "project" | "global";
}

// Discover and merge all MCP servers across global, profile and each workspace project, following the omp source mcps capability
export async function loadAllMcpScoped(options?: { probe?: boolean }) {
  clearCapabilityFsCache();
  const userMcpPath = path.join(H.agentDir, "mcp.json");
  const [disabledList, forcedList] = await Promise.all([
    readDisabledServers(userMcpPath).catch(() => [] as string[]),
    readEnabledServers(userMcpPath).catch(() => [] as string[]),
  ]);
  const disabledSet = new Set<string>(disabledList);
  const forcedSet = new Set<string>(forcedList);

  const isServerEnabled = (name: string, rawEnabled?: boolean) => {
    if (disabledSet.has(name)) return false;
    if (rawEnabled === false && !forcedSet.has(name)) return false;
    return true;
  };

  const allServersMap = new Map<string, McpServerAsset>();
  const rawFileCache = new Map<string, any>();
  const readRawSharing = async (filePath?: string, serverName?: string): Promise<"session" | "project" | "global" | undefined> => {
    if (!filePath || !serverName) return undefined;
    const desktopSharing = getMcpSharingConfig(filePath, serverName);
    if (desktopSharing) return desktopSharing;
    try {
      let doc = rawFileCache.get(filePath);
      if (!doc) {
        if (fs.existsSync(filePath)) {
          doc = JSON.parse(await readFile(filePath, "utf8"));
          rawFileCache.set(filePath, doc);
        }
      }
      const raw = doc?.mcpServers?.[serverName]?.sharing;
      if (raw === "session" || raw === "project" || raw === "global") return raw;
      return undefined;
    } catch {
      return undefined;
    }
  };

  const serverKey = (scope: string, name: string) => `${scope}::${name}`;

  // 1. User-level discovery (current profile plus global external sources such
  //    as ~/.claude.json, ~/.cursor/mcp.json, ~/.codex/config.toml).
  //    includeDisabled is not passed: external user-level sources stay gated by
  //    the "sources" and "external tools ~/ config" switches (same as base runtime loading)
  try {
    const userRes = await loadCapability<any>("mcps", { cwd: H.agentDir });
    for (const s of userRes.items) {
      const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
      const enabled = isServerEnabled(s.name, s.enabled);
      const filePath = s._source?.path ?? userMcpPath;
      const fileSharing = await readRawSharing(filePath, s.name);
      const rawSharing = fileSharing ?? s.sharing ?? (s as any)._config?.sharing;
      const sharing: "session" | "project" | "global" =
        (rawSharing === "global" || rawSharing === "project") ? rawSharing : "session";
      allServersMap.set(serverKey("profile", s.name), {
        name: s.name,
        transport,
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        env: s.env,
        cwd: s.cwd,
        enabled,
        sharing,
        source: {
          provider: s._source?.provider ?? "native",
          providerName: s._source?.providerName ?? "OMP",
          path: filePath,
          level: s._source?.level ?? "user",
        },
        scope: "profile",
        status: enabled ? "unknown" : "disabled",
      });
    }
  } catch (err) {
    safeStderr(hostI18n.t("errors.mcpDiscovery.userScopeFailed", { detail: String(err) }));
  }

  // Read the current profile's mcp.json directly so freshly saved config and the sharing field stay 100% in sync
  if (fs.existsSync(userMcpPath)) {
    try {
      const rawUserDoc = JSON.parse(await readFile(userMcpPath, "utf8"));
      for (const [name, cfg] of Object.entries<any>(rawUserDoc.mcpServers || {})) {
        const transport = (cfg.type ?? (cfg.command ? "stdio" : cfg.url ? "http" : "stdio")) as "stdio" | "http" | "sse";
        const enabled = isServerEnabled(name, cfg.enabled);
        const rawSharing = getMcpSharingConfig(userMcpPath, name) ?? cfg.sharing;
        const sharing: "session" | "project" | "global" =
          (rawSharing === "global" || rawSharing === "project") ? rawSharing : "session";
        const uKey = serverKey("profile", name);
        const existing = allServersMap.get(uKey);
        if (existing) {
          existing.command = cfg.command ?? existing.command;
          existing.args = cfg.args ?? existing.args;
          existing.url = cfg.url ?? existing.url;
          existing.headers = cfg.headers ?? existing.headers;
          existing.env = cfg.env ?? existing.env;
          existing.cwd = cfg.cwd ?? existing.cwd;
          existing.sharing = sharing;
          existing.transport = transport;
        } else {
          allServersMap.set(uKey, {
            name,
            transport,
            command: cfg.command,
            args: cfg.args,
            url: cfg.url,
            headers: cfg.headers,
            env: cfg.env,
            cwd: cfg.cwd,
            enabled,
            sharing,
            source: {
              provider: "native",
              providerName: "OMP",
              path: userMcpPath,
              level: "user",
            },
            scope: "profile",
            status: enabled ? "unknown" : "disabled",
          });
        }
      }
    } catch {}
  }

  // 2. Project workspace discovery (each project opened in the desktop app)
  const projectScopeList: { cwd: string; name: string; dir: string; count: number }[] = [];
  for (const cwd of validDesktopProjects()) {
    let count = 0;
    const primaryOmpDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    const projMcpFile = path.join(primaryOmpDir, "mcp.json");
    const projScope = `project:${cwd}`;

    try {
      const projRes = await loadCapability<any>("mcps", { cwd });
      for (const s of projRes.items) {
        // base loadCapability cascades user-level capabilities back; only handle MCP entries owned by the current project
        if (s._source?.level !== "project") continue;
        const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
        const enabled = isServerEnabled(s.name, s.enabled);
        const filePath = s._source?.path ?? projMcpFile;
        const fileSharing = await readRawSharing(filePath, s.name);
        const rawSharing = fileSharing ?? s.sharing ?? (s as any)._config?.sharing;
        const sharing: "session" | "project" | "global" =
          rawSharing === "project" ? "project" : "session"; // rule 2: global forbidden inside a project; rule 1: default session
        const item: McpServerAsset = {
          name: s.name,
          transport,
          command: s.command,
          args: s.args,
          url: s.url,
          headers: s.headers,
          env: s.env,
          cwd: s.cwd ?? cwd,
          enabled,
          sharing,
          source: {
            provider: s._source?.provider ?? "native",
            providerName: s._source?.providerName ?? hostI18n.t("flows.mcp.projectConfig"),
            path: filePath,
            level: "project",
          },
          scope: projScope,
          projectName: path.basename(cwd),
          status: enabled ? "unknown" : "disabled",
        };
        allServersMap.set(serverKey(projScope, s.name), item);
        count++;
      }
    } catch (err) {
      safeStderr(hostI18n.t("errors.mcpDiscovery.projectScopeFailed", { cwd, detail: String(err) }));
    }

    // Read the project .omp/mcp.json directly so project-level additions and sharing sync 100%
    if (fs.existsSync(projMcpFile)) {
      try {
        const rawProjDoc = JSON.parse(await readFile(projMcpFile, "utf8"));
        for (const [name, cfg] of Object.entries<any>(rawProjDoc.mcpServers || {})) {
          const transport = (cfg.type ?? (cfg.command ? "stdio" : cfg.url ? "http" : "stdio")) as "stdio" | "http" | "sse";
          const enabled = isServerEnabled(name, cfg.enabled);
          const rawSharing = getMcpSharingConfig(projMcpFile, name) ?? cfg.sharing;
          const sharing: "session" | "project" | "global" =
            rawSharing === "project" ? "project" : "session";
          const pKey = serverKey(projScope, name);
          const existing = allServersMap.get(pKey);
          if (existing) {
            existing.command = cfg.command ?? existing.command;
            existing.args = cfg.args ?? existing.args;
            existing.url = cfg.url ?? existing.url;
            existing.headers = cfg.headers ?? existing.headers;
            existing.env = cfg.env ?? existing.env;
            existing.cwd = cfg.cwd ?? existing.cwd ?? cwd;
            existing.sharing = sharing;
            existing.transport = transport;
          } else {
            allServersMap.set(pKey, {
              name,
              transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              headers: cfg.headers,
              env: cfg.env,
              cwd: cfg.cwd ?? cwd,
              enabled,
              sharing,
              source: {
                provider: "native",
                providerName: hostI18n.t("flows.mcp.projectConfig"),
                path: projMcpFile,
                level: "project",
              },
              scope: projScope,
              projectName: path.basename(cwd),
              status: enabled ? "unknown" : "disabled",
            });
            count++;
          }
        }
      } catch {}
    }

    projectScopeList.push({ cwd, name: path.basename(cwd), dir: primaryOmpDir, count });
  }

  const serverList = Array.from(allServersMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 3. Concurrent health checks (fast probes against enabled servers, 2s timeout).
  // Skipped on the session-mount path ({ probe: false }): mounting must not pay
  // the per-server connect budget — status stays "unknown" there.
  if (options?.probe !== false) {
    const enabledServers = serverList.filter((s) => s.enabled);
    await Promise.all(
      enabledServers.map(async (s) => {
        const probe = await probeMcpServerHealth(s);
        if (probe) {
          s.status = probe.status;
          s.error = probe.error;
          s.log = probe.log;
        } else {
          s.status = "connected";
        }
      })
    );
  }

  for (const s of serverList) {
    if (!s.enabled) {
      s.status = "disabled";
      s.error = undefined;
      s.log = undefined;
    }
  }

  // Legacy asset fields for backward compatibility
  const mcpProfile = {
    path: userMcpPath,
    servers: serverList.filter((s) => s.scope === "profile").map((s) => ({
      name: s.name,
      command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "",
    })),
  };
  const mcpProjects = projectScopeList.map((p) => ({
    cwd: p.cwd,
    name: p.name,
    path: path.join(p.dir, "mcp.json"),
    servers: serverList.filter((s) => s.scope === `project:${p.cwd}`).map((s) => ({
      name: s.name,
      command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "",
    })),
  }));

  const scopes = [
    { id: "profile", name: `Profile · ${H.currentProfile}`, count: serverList.filter((s) => s.scope === "profile").length, dir: userMcpPath },
    ...projectScopeList.map((p) => ({
      id: `project:${p.cwd}`,
      name: p.name,
      cwd: p.cwd,
      count: serverList.filter((s) => s.scope === `project:${p.cwd}`).length,
      dir: path.join(p.dir, "mcp.json"),
    })),
  ];

  return {
    servers: serverList,
    scopes,
    userMcpPath,
    global: mcpProfile, // backward compat
    profile: mcpProfile,
    projects: mcpProjects,
    profileName: H.currentProfile,
  };
}
