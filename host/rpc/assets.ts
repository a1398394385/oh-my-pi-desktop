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
import {
  listAgentAssets,
  probeMcpServerHealth,
  mcpHealthCache,
  nearestProjectOmpDir,
  assetOmpDir,
  mcpCandidates,
  resolveAssetFile,
  type AssetKind,
} from "../assets.ts";
import { setMcpSharingConfig, deleteMcpSharingConfig } from "../profile.ts";
import {
  buildExtensionsPayload,
  toggleExtensionItem,
  toggleExtensionProvider,
  toggleExtensionUserSource,
} from "../extensions.ts";
import { rebuildScopedModels } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";
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
    // Place by scope and asset kind: agent=agents/<name>.md, skill=skills/<name>/SKILL.md, mcp=that scope's mcp.json (idempotent), hook=hooks/<phase>/<tool>.ts (from a phase-aware template)
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
      const toolName = String(msg.name ?? "").trim();
      if (!/^(\*|[A-Za-z0-9][A-Za-z0-9_-]*)$/.test(toolName)) throw new Error(hostI18n.t("errors.asset.invalidToolName"));
      const phase = msg.phase === "pre" || msg.phase === "post" ? msg.phase : null;
      if (!phase) throw new Error(hostI18n.t("errors.asset.invalidPhase"));
      const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), "hooks", phase);
      const file = path.join(dir, `${toolName}.ts`);
      if (fs.existsSync(file)) throw new Error(hostI18n.t("errors.asset.alreadyExists", { kind, name: toolName }));
      await mkdir(dir, { recursive: true });
      const filter = toolName === "*" ? "" : `\t\tif (event.toolName !== "${toolName}") return;\n`;
      const content =
        phase === "pre"
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
    await toggleExtensionItem(msg.id, msg.enabled, msg.sourcePath);
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
    const projectPath = msg.cwd
      ? (nearestProjectOmpDir(msg.cwd) ? path.join(nearestProjectOmpDir(msg.cwd)!, "mcp.json") : path.join(path.resolve(msg.cwd), ".omp", "mcp.json"))
      : undefined;
    await setMcpServerEnabled({
      userPath,
      projectPath: projectPath ?? userPath,
      sourcePath: msg.sourcePath ? String(msg.sourcePath) : undefined,
      name,
      enabled,
    });
    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
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
  async mcp_detach(_ws, msg) {
    // Frontend LRU eviction signal: release the evicted session's MCP pool
    // references and unmount its tool surface (pool boundary semantics — no
    // mid-session toggling). Reopening goes through load_session, which
    // re-mounts idempotently.
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.param.missingPath"));
    for (const [key, entry] of sessions.entries()) {
      if (entry.path === p) releaseMcpForSession(key, entry);
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
    const isProject = scope.startsWith("project:");
    const sourcePath = msg.sourcePath ? String(msg.sourcePath) : undefined;
    // Rule 2: the project scope forbids global; force-correct to project
    if (isProject && cfg.sharing === "global") {
      cfg.sharing = "project";
    }
    // Rule 1: the default is strictly the session level
    if (!cfg.sharing) {
      cfg.sharing = "session";
    }
    const targetDir = (scope === "profile" || scope === "global")
      ? H.agentDir
      : isProject
      ? (nearestProjectOmpDir(scope.slice(8)) ?? path.join(path.resolve(scope.slice(8)), ".omp"))
      : H.agentDir;
    await mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, "mcp.json");

    const isExternalSource = Boolean(sourcePath && path.resolve(sourcePath) !== path.resolve(targetPath));
    if (isExternalSource && !msg.forceImport) {
      // External-source decoupling: record the sharing mode in omp-desktop.json, create no local shadow override, keep external tools read dynamically
      await setMcpSharingConfig(sourcePath!, name, cfg.sharing);
    } else {
      // Native OMP MCP or explicit import: write mcp.json and record the sharing in omp-desktop.json in sync
      await updateMCPServer(targetPath, name, cfg);
      await setMcpSharingConfig(targetPath, name, cfg.sharing);
      if (sourcePath && path.resolve(sourcePath) !== path.resolve(targetPath)) {
        await deleteMcpSharingConfig(sourcePath, name);
      }
    }

    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async delete_mcp_server(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.param.missingMcpName"));
    const src = msg.sourcePath ? String(msg.sourcePath) : undefined;
    const userPath = path.join(H.agentDir, "mcp.json");
    const targetFile = src ?? userPath;
    if (src) await deleteMcpSharingConfig(src, name);
    await deleteMcpSharingConfig(userPath, name);
    if (fs.existsSync(targetFile) && (targetFile.endsWith("mcp.json") || targetFile.endsWith(".mcp.json"))) {
      await removeMCPServer(targetFile, name);
    } else {
      await setMcpServerEnabled({
        userPath,
        projectPath: userPath,
        sourcePath: src,
        name,
        enabled: false,
      });
    }
    mcpHealthCache.delete(name);
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
};
