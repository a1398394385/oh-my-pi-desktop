// 资产域 RPC：skills/agents/mcp 磁盘资产的读写/新建/删除、记忆文件读取、
// 扩展中心清单与开关、MCP 服务器启停/测试/保存（外部来源解耦）/删除。
// 自 main.ts message 分发平移（第三刀）。
import path from "node:path";
import fs from "node:fs";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import {
  setMcpServerEnabled,
  updateMCPServer,
  removeMCPServer,
} from "../bootstrap.ts";
import { H } from "../state.ts";
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
import type { RpcHandler } from "./types";

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
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`路径不在允许的记忆目录内: ${raw}`);
    // 工作区记忆是目录：返回顶层 .md 清单（按修改时间新→旧）并默认读最新的一个
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
      if (!files.length) throw new Error(`记忆目录内没有 .md 文件: ${raw}`);
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
    // 按作用域与资产类型落位：agent=agents/<name>.md、skill=skills/<name>/SKILL.md、mcp=该级 mcp.json（幂等，已存在则直接返回内容）
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
    const name = String(msg.name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("名称仅允许小写字母、数字、-、_");
    const dir = path.join(assetOmpDir(kind, msg.scope, msg.cwd), kind === "agent" ? "agents" : "skills");
    await mkdir(dir, { recursive: true });
    const file = kind === "agent" ? path.join(dir, `${name}.md`) : path.join(dir, name, "SKILL.md");
    if (fs.existsSync(file)) throw new Error(`${kind} 已存在: ${name}`);
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
    if (!name) throw new Error("缺少技能名称");
    const disabled = new Set<string>(((H.settings.get("disabledExtensions") ?? []) as string[]));
    const ignored = new Set<string>(((H.settings.get("skills.ignoredSkills") ?? []) as string[]));
    const skillExtId = `skill:${name}`;
    if (enabled) {
      disabled.delete(skillExtId);
      ignored.delete(name);
    } else {
      disabled.add(skillExtId);
    }
    H.settings.set("disabledExtensions", Array.from(disabled));
    H.settings.set("skills.ignoredSkills", Array.from(ignored));
    await H.settings.flush();
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async asset_skill_delete(ws, msg) {
    const rawPath = String(msg.path ?? "");
    const file = resolveAssetFile("skill", rawPath);
    if (!fs.existsSync(file)) throw new Error(`技能文件不存在: ${file}`);
    const skillDir = path.dirname(file);
    const parentDir = path.dirname(skillDir);
    // 如果是常规的 <skillName>/SKILL.md，安全删除整个技能目录
    if (path.basename(file).toLowerCase() === "skill.md" && parentDir && parentDir !== skillDir) {
      await rm(skillDir, { recursive: true, force: true });
    } else {
      await rm(file, { force: true });
    }
    ws.send(JSON.stringify({ type: "asset_file_deleted", kind: "skill", path: file }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async list_extensions(ws, msg) {
    // 扩展中心数据帧：scope=profile（用户级+原生）或 project:<cwd>（项目级）
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async toggle_extension_item(ws, msg) {
    await toggleExtensionItem(msg.id, msg.enabled, msg.sourcePath);
    ws.send(JSON.stringify({ type: "extensions", ...(await buildExtensionsPayload(msg.scope)) }));
  },
  async toggle_extension_provider(ws, msg) {
    const enabled = await toggleExtensionProvider(msg.providerId);
    // 与 set_setting 的 model 键副作用对齐：重建 scoped 目录并推送 models 帧
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
    if (!name) throw new Error("缺少 MCP 服务器名称");
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
    if (!name) throw new Error("缺少 MCP 服务器名称");
    mcpHealthCache.delete(name);
    const probe = await probeMcpServerHealth(msg.server || { name });
    ws.send(JSON.stringify({ type: "mcp_server_tested", name, status: probe.status, error: probe.error, log: probe.log }));
  },
  async save_mcp_server(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error("缺少 MCP 服务器名称");
    const cfg = msg.config || {};
    const scope = String(msg.scope ?? "profile");
    const isProject = scope.startsWith("project:");
    const sourcePath = msg.sourcePath ? String(msg.sourcePath) : undefined;
    // 规则 2：项目作用域禁止配置为 global，强制纠正为 project
    if (isProject && cfg.sharing === "global") {
      cfg.sharing = "project";
    }
    // 规则 1：缺省严格为 session 会话级
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
      // 外部来源解耦：共享模式记录至 omp-desktop.json，不创建本地 shadow 覆盖，保持外部工具动态直读
      await setMcpSharingConfig(sourcePath!, name, cfg.sharing);
    } else {
      // 原生 OMP MCP 或显式导入：写入 mcp.json 并同步记录在 omp-desktop.json
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
    if (!name) throw new Error("缺少 MCP 服务器名称");
    const src = msg.sourcePath ? String(msg.sourcePath) : undefined;
    const userPath = path.join(H.agentDir, "mcp.json");
    if (src) await deleteMcpSharingConfig(src, name);
    await deleteMcpSharingConfig(userPath, name);
    if (src && fs.existsSync(src) && (src.endsWith("mcp.json") || src.endsWith(".mcp.json"))) {
      await removeMCPServer(src, name);
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
