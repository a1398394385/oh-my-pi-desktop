// Asset domain RPC: read/write/create/delete of skills/agents/mcp disk
// assets, memory file reads, extensions center listing and switches, MCP
// server enable/test/save (external-source decoupling)/delete.
// Moved over from the main.ts message dispatch (third slice).
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  setMcpServerEnabled,
  updateMCPServer,
  removeMCPServer,
} from "../bootstrap.ts";
import { H, sessions } from "../state.ts";
import { releaseMcpForSession, preloadMcpForCwd } from "../mcp-mount.ts";
import { detachEntryUi } from "../session-entry-core.ts";
import { listAgentAssets, HOOK_EVENTS, LIFECYCLE_EVENTS } from "../assets.ts";
import {
  probeMcpServerHealth,
  mcpHealthCache,
} from "../mcp-assets.ts";
import {
  assetOmpDir,
  mcpCandidates,
  scopeMcpFiles,
  resolveAssetFile,
  validDesktopProjects,
  type AssetKind,
} from "../asset-paths.ts";
import { setPluginEnabled, installPluginPackage } from "../plugin-assets.ts";
import { setMcpSharingConfig, deleteMcpSharingConfig } from "../profile.ts";
import {
  buildExtensionsPayload,
  toggleExtensionItem,
  toggleExtensionProvider,
  toggleExtensionUserSource,
} from "../extensions.ts";
import { rebuildScopedModels } from "../models.ts";
import { modelsFrame, settingsFrame } from "../frames.ts";
import { KIMI_CU_SERVER, kimiCuBinaryPath, warmBuiltinServer } from "../mcp-builtin.ts";
import { hostI18n } from "../i18n/host.ts";
import type { RpcHandler } from "./types";
import { safeStderr } from "../stderr.ts";
import { settingsGet, settingsSet } from "../settings-compat.ts";

export const assetsHandlers: Record<string, RpcHandler> = {
  async list_agent_assets(ws) {
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_file_read(ws, msg) {
    const kind = String(msg.kind ?? "agent") as AssetKind;
    const file = resolveAssetFile(kind, msg.path);
    const content = await readFile(file, "utf8");
    ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
  },
  async memory_file_read(ws, msg) {
    const raw = String(msg.path ?? "");
    const file = path.resolve(raw);
    const rel = path.relative(path.resolve(path.join(H.agentDir, "memories")), file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(hostI18n.t("errors.memory.outsideDir", { path: raw }));
    // Workspace memories are directories: return the top-level .md list (newest first by mtime) and read the newest one by default
    let target = file;
    let files: string[] | undefined;
    let rollouts: string[] | undefined;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const mtime = (dir: string, n: string) => {
        try {
          return fs.statSync(path.join(dir, n)).mtimeMs;
        } catch {
          return 0;
        }
      };
      files = (await readdir(file))
        .filter((n) => n.endsWith(".md") && !n.startsWith("."))
        .sort((a, b) => mtime(file, b) - mtime(file, a));
      if (!files.length) throw new Error(hostI18n.t("errors.memory.noMdFiles", { path: raw }));
      target = path.join(file, files[0]);
      const rollDir = path.join(file, "rollout_summaries");
      rollouts = (await readdir(rollDir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".md") && !n.startsWith("."))
        .sort((a, b) => mtime(rollDir, b) - mtime(rollDir, a));
    }
    const content = await readFile(target, "utf8");
    ws.send(JSON.stringify({ type: "memory_file", path: file, file: path.basename(target), files, rollouts, content }));
  },
  async asset_file_write(ws, msg) {
    const kind = String(msg.kind ?? "agent") as AssetKind;
    const file = resolveAssetFile(kind, msg.path);
    await writeFile(file, String(msg.content ?? ""), "utf8");
    ws.send(JSON.stringify({ type: "asset_file_saved", kind, path: file }));
  },
  async asset_file_create(ws, msg) {
    // Place by scope and asset kind: agent=agents/<name>.md, skill=skills/<name>/SKILL.md, mcp=that scope's mcp.json (idempotent), hook=hooks/<phase>/<tool|event>.ts (from an event-aware template)
    const kind = String(msg.kind ?? "agent") as AssetKind;
    if (kind === "mcp") {
      const file = mcpCandidates(assetOmpDir(kind, msg.scope, msg.cwd))[0];
      if (fs.existsSync(file)) {
        ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content: await readFile(file, "utf8") }));
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      const content = `{\n  "mcpServers": {}\n}\n`;
      await writeFile(file, content, "utf8");
      ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
      return;
    }
    if (kind === "hook") {
      const event = String(msg.event ?? "");
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) throw new Error(hostI18n.t("errors.asset.invalidEvent", { event }));
      // Discovery only scans hooks/{pre,post}/: lifecycle events are stored as hooks/pre/<event>.ts
      // (basename = event), tool events keep hooks/<phase>/<tool>.ts where the phase is event-derived.
      const lifecycle = (LIFECYCLE_EVENTS as readonly string[]).includes(event);
      const phase = lifecycle ? "pre" : event === "tool_result" ? "post" : "pre";
      const toolName = lifecycle ? event : String(msg.name ?? "").trim() || "*";
      if (!lifecycle && !/^(\*|[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(toolName)) throw new Error(hostI18n.t("errors.asset.invalidToolName"));
      const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), "hooks", phase);
      const file = path.join(dir, `${toolName}.ts`);
      if (fs.existsSync(file)) throw new Error(hostI18n.t("errors.asset.alreadyExists", { kind, name: toolName }));
      await mkdir(dir, { recursive: true });
      const filter = toolName === "*" ? "" : `\t\tif (event.toolName !== "${toolName}") return;\n`;
      const content = lifecycle
        ? `/**\n * ${event} hook: runs on the session "${event}" event (pi.on("${event}")).\n * One file per event; reload picks it up on new sessions.\n */\nexport default function (pi) {\n\tpi.on("${event}", async (event) => {\n\t\t// Run a command: await pi.exec("git", ["status"], { timeout: 30_000 });\n\t\t// Post a message to the transcript: await pi.sendMessage("...");\n\t});\n}\n`
        : phase === "pre"
          ? `/**\n * Pre-tool hook: runs before the tool executes (pi.on("tool_call")).\n * File name targets one tool ("*" matches all); reload picks it up on new sessions.\n */\nexport default function (pi) {\n\tpi.on("tool_call", async (event) => {\n${filter}\t\t// Block the call: return { block: true, reason: "not allowed" };\n\t\t// Revise the input: return { input: { ...event.input } };\n\t});\n}\n`
          : `/**\n * Post-tool hook: runs after the tool executes (pi.on("tool_result")).\n * File name targets one tool ("*" matches all); reload picks it up on new sessions.\n */\nexport default function (pi) {\n\tpi.on("tool_result", async (event) => {\n${filter}\t\t// Revise the result: return { content: [{ type: "text", text: "..." }] };\n\t});\n}\n`;
      await writeFile(file, content, "utf8");
      ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
      ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
      return;
    }
    const name = String(msg.name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(hostI18n.t("errors.asset.invalidName"));
    const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), kind === "agent" ? "agents" : "skills");
    await mkdir(dir, { recursive: true });
    const file = kind === "agent" ? path.join(dir, `${name}.md`) : path.join(dir, name, "SKILL.md");
    if (fs.existsSync(file)) throw new Error(hostI18n.t("errors.asset.alreadyExists", { kind, name }));
    await mkdir(path.dirname(file), { recursive: true });
    const content =
      kind === "agent"
        ? `---\nname: ${name}\ndescription: \ntools: read, grep, glob\n---\n\n`
        : `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
    await writeFile(file, content, "utf8");
    ws.send(JSON.stringify({ type: "asset_file", kind, path: file, content }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_plugin_toggle(ws, msg) {
    const name = String(msg.name ?? "").trim();
    const enabled = Boolean(msg.enabled);
    const rawScope = String(msg.scope ?? "profile");
    if (!name) throw new Error(hostI18n.t("errors.param.missingPluginName"));
    let scope: "profile" | "project";
    let cwd: string | undefined;
    if (rawScope === "project") {
      cwd = String(msg.cwd ?? "");
      if (!validDesktopProjects().includes(cwd)) throw new Error(hostI18n.t("errors.asset.unknownProject", { c: cwd }));
      scope = "project";
    } else if (rawScope === "profile") {
      scope = "profile";
    } else {
      throw new Error(hostI18n.t("errors.param.unknownPluginScope", { scope: rawScope }));
    }
    await setPluginEnabled(scope, cwd, name, enabled);
    // NOTE: sessions cache their plugin set at spawn — the toggle takes effect for
    // sessions created afterwards, matching the base's load-time discovery semantics.
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_plugin_install(ws, msg) {
    const spec = String(msg.spec ?? "").trim();
    if (!spec) throw new Error(hostI18n.t("errors.param.missingPluginSpec"));
    // Install errors are reported on the result frame (not as a thrown error frame):
    // the UI keeps an in-flight install button until a terminal reply lands, and a
    // failed `bun install` is an expected outcome worth showing inline.
    try {
      const res = await installPluginPackage(spec);
      ws.send(JSON.stringify({ type: "plugin_install_result", ok: true, ...res }));
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "plugin_install_result",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_skill_toggle(ws, msg) {
    const name = String(msg.name ?? "").trim();
    const enabled = Boolean(msg.enabled);
    if (!name) throw new Error(hostI18n.t("errors.param.missingSkillName"));
    const disabled = new Set<string>(((settingsGet(H.settings, "disabledExtensions") ?? []) as string[]));
    const ignored = new Set<string>(((settingsGet(H.settings, "skills.ignoredSkills") ?? []) as string[]));
    const skillExtId = `skill:${name}`;
    if (enabled) {
      disabled.delete(skillExtId);
      ignored.delete(name);
    } else {
      disabled.add(skillExtId);
    }
    settingsSet(H.settings, "disabledExtensions", Array.from(disabled));
    settingsSet(H.settings, "skills.ignoredSkills", Array.from(ignored));
    await H.settings.flush();
    // The base's cfgSkillsAndCommandsDiscovery listener covers skills.* edits
    // but not disabledExtensions, so live sessions keep their stale skill
    // lists until restart. Re-discover them here to close that gap host-side.
    await Promise.all(
      [...sessions.values()].map((e) =>
        e.session.refreshSkillsAndCommands().catch((err) => {
          safeStderr(`[host] skill toggle: session refresh failed: ${String(err)}\n`);
        })
      )
    );
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_skill_delete(ws, msg) {
    const rawPath = String(msg.path ?? "");
    const file = resolveAssetFile("skill", rawPath);
    if (!fs.existsSync(file)) throw new Error(hostI18n.t("errors.asset.skillFileNotFound", { file }));
    const skillDir = path.dirname(file);
    const parentDir = path.dirname(skillDir);
    // For a regular <skillName>/SKILL.md, safely delete the whole skill directory
    if (path.basename(file).toLowerCase() === "skill.md" && parentDir && parentDir !== skillDir) {
      await rm(skillDir, { recursive: true, force: true });
    } else {
      await rm(file, { force: true });
    }
    ws.send(JSON.stringify({ type: "asset_file_deleted", kind: "skill", path: file }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async list_extensions(ws, msg) {
    // Extensions center data frame: scope=profile (user level + native) or project:<cwd> (project level)
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async toggle_extension_item(ws, msg) {
    await toggleExtensionItem(msg.id, msg.enabled, msg.sourcePath, msg.scope);
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async toggle_extension_provider(ws, msg) {
    const enabled = await toggleExtensionProvider(msg.providerId);
    // Aligned with set_setting's model-key side effect: rebuild the scoped catalog and push a models frame
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async toggle_extension_user_source(ws, msg) {
    await toggleExtensionUserSource(msg.providerId);
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async set_mcp_server_enabled(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    const enabled = Boolean(msg.enabled);
    const userPath = path.join(H.agentDir, "mcp.json");
    const files = scopeMcpFiles(msg.scope);
    const sourcePath = msg.sourcePath ? String(msg.sourcePath) : undefined;
    const writable = !sourcePath || files.some((p) => path.resolve(p) === path.resolve(sourcePath));
    await setMcpServerEnabled({
      userPath,
      // Read-only sources (plugin packages, other tools' configs) must keep their file
      // untouched: without sourcePath/projectPath the switch lands in the user
      // denylist/allowlist, the base runtime's supported override.
      projectPath: writable ? files[0] : userPath,
      sourcePath: writable ? sourcePath : undefined,
      name,
      enabled,
    });
    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async test_kimi_cu(ws) {
    // Computer page's Kimi "Test connection" button: the kimi-cu server is
    // code-owned (host/mcp-builtin.ts, never in mcp.json), so the test is the
    // pool warm itself — acquire the shared global connection, release it back
    // to the idle pool. The reply rides the existing mcp_server_tested frame,
    // so the frontend toasts the result with the standard MCP wording.
    const bin = kimiCuBinaryPath();
    if (!bin) {
      ws.send(JSON.stringify({ type: "mcp_server_tested", name: KIMI_CU_SERVER, status: "error", error: hostI18n.t("errors.kimiCuNotInstalled") }));
      return;
    }
    const ok = await warmBuiltinServer(KIMI_CU_SERVER);
    ws.send(
      JSON.stringify(
        ok
          ? { type: "mcp_server_tested", name: KIMI_CU_SERVER, status: "ok" }
          : { type: "mcp_server_tested", name: KIMI_CU_SERVER, status: "error", error: hostI18n.t("errors.kimiCuConnectFailed") },
      ),
    );
  },
  async test_mcp_server(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    mcpHealthCache.delete(name);
    const probe = await probeMcpServerHealth(msg.server || { name });
    // probeMcpServerHealth returns "connected"/"error"; the frontend contract for
    // this reply is "ok"/"error" (McpServerTestedFrame consumers + smoke-mcp-sharing)
    ws.send(JSON.stringify({ type: "mcp_server_tested", name, status: probe.status === "connected" ? "ok" : "error", error: probe.error, log: probe.log }));
  },
  async mcp_detach(ws, msg) {
    // Frontend LRU eviction signal: the session is no longer open on this channel.
    // Release its MCP pool references, unmount its tool surface (pool boundary
    // semantics — no mid-session toggling) AND leave the session's fan-out set:
    // sweepIdlePoolSessions skips entries with any attached socket, so a stale
    // attachment pinned the evicted session in the pool (and the sidebar's active
    // tasks list) for as long as the window stayed open. Reopening goes through
    // load_session, which re-attaches the socket and re-mounts idempotently.
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    for (const [key, entry] of sessions.entries()) {
      if (entry.path !== p) continue;
      releaseMcpForSession(key, entry);
      detachEntryUi(ws, entry);
    }
  },
  async preload_mcp(_ws, msg) {
    // New-session warm-up: the frontend fires this the moment the project for a
    // not-yet-created session is known (welcome-screen project selection), so
    // shared connections are pooled before create_session arrives
    const cwd = String(msg.cwd ?? "").trim();
    if (!cwd) throw new Error(hostI18n.t("errors.param.missingCwd"));
    await preloadMcpForCwd(cwd);
  },
  async save_mcp_server(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    const cfg = msg.config || {};
    const scope = String(msg.scope ?? "profile");
    const files = scopeMcpFiles(scope);
    const targetPath = files[0];
    const sourcePath = msg.sourcePath ? String(msg.sourcePath) : undefined;
    // Rule 2: the project scope forbids global; force-correct to project
    if (scope.startsWith("project:") && cfg.sharing === "global") {
      cfg.sharing = "project";
    }
    // Rule 1: the default is strictly the session level
    if (!cfg.sharing) {
      cfg.sharing = "session";
    }
    if (sourcePath && !files.some((p) => path.resolve(p) === path.resolve(sourcePath))) {
      // Read-only row (plugin package, another tool's config): the source file keeps
      // its definition, but the sharing mode lives in omp-desktop.json (which sessions
      // get the server), so that one field stays editable.
      await setMcpSharingConfig(sourcePath, name, cfg.sharing);
      mcpHealthCache.delete(name);
      ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
      return;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await updateMCPServer(targetPath, name, cfg);
    // Record the sharing in omp-desktop.json in sync with the config file
    await setMcpSharingConfig(targetPath, name, cfg.sharing);

    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async delete_mcp_server(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    const scope = String(msg.scope ?? "profile");
    const files = scopeMcpFiles(scope);
    const targetPath = files[0];
    const sourcePath = msg.sourcePath ? String(msg.sourcePath) : undefined;
    // Read-only rows (plugin packages, other tools' configs) are never deleted from
    if (sourcePath && !files.some((p) => path.resolve(p) === path.resolve(sourcePath))) {
      throw new Error(hostI18n.t("errors.mcp.readOnlySource"));
    }
    const file = sourcePath ?? targetPath;
    await deleteMcpSharingConfig(file, name);
    if (path.resolve(file) !== path.resolve(targetPath)) await deleteMcpSharingConfig(targetPath, name);
    await removeMCPServer(file, name);
    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
};
