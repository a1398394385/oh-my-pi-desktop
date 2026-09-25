// 磁盘资产域：agent 定义 / skill / mcp 配置的三级（全局 ~/.omp、profile agentDir、各桌面项目）
// 扫描、读取、健康探测与聚合。listAgentAssets 是 list_agent_assets 命令的聚合入口。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { H } from "./state.ts";
import {
  loadCapability,
  connectToServer,
  disconnectServer,
  readDisabledServers,
  readEnabledServers,
} from "./bootstrap.ts";

async function firstHeading(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const m = text.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// agent 定义描述：优先 YAML frontmatter 的 description，退回一级标题
async function agentFileDescription(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*(.+?)\s*$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
    const h = text.match(/^#\s+(.+)$/m);
    if (h) return h[1].trim();
  } catch {}
  return "";
}

// omp 发现规则：从项目目录向上找最近的 .omp 配置目录
export function nearestProjectOmpDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  for (;;) {
    const cand = path.join(dir, ".omp");
    if (fs.existsSync(cand)) return cand;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

// 磁盘资产（agent 定义 / skill / mcp 配置）的可读写根：
// 当前 profile 的 agentDir/<sub>、每个有效桌面项目向上最近的 .omp/<sub>
export type AssetKind = "agent" | "skill" | "mcp";

export interface AssetRoot { dir: string; scope: string; cwd?: string }

// 仅使用 omp-desktop.json 登记且未被移除的有效桌面项目
export function validDesktopProjects(): string[] {
  const removed = new Set(H.desktopProjects.removedProjects);
  return H.desktopProjects.allProjects.filter((c) => !removed.has(c));
}

export function assetRoots(kind: AssetKind): AssetRoot[] {
  const sub = kind === "agent" ? "agents" : "skills";
  const roots: AssetRoot[] = [
    { dir: path.join(H.agentDir, sub), scope: "profile" },
  ];
  for (const cwd of validDesktopProjects()) {
    const ompDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    roots.push({ dir: path.join(ompDir, sub), scope: "project", cwd });
  }
  return roots;
}

// 某级作用域下的 omp 配置目录（mcp.json 所在目录）
export function assetOmpDir(kind: AssetKind, scope: unknown, cwd?: unknown): string {
  const s = String(scope ?? "profile");
  if (s === "profile" || s === "global") return H.agentDir;
  if (s === "project") {
    const c = String(cwd ?? "");
    if (!validDesktopProjects().includes(c)) throw new Error(`未知的项目: ${c}`);
    return nearestProjectOmpDir(c) ?? path.join(path.resolve(c), ".omp");
  }
  throw new Error(`未知的作用域: ${s}`);
}

// mcp.json 候选文件（带点的在前优先读，无前缀为主写入目标）
export function mcpCandidates(dir: string): string[] {
  return [path.join(dir, "mcp.json"), path.join(dir, ".mcp.json")];
}

// 所有合法的技能根目录（含全局 OMP/Agents/Claude/Codex/OpenCode、Profile、项目各级）
function allSkillRoots(): string[] {
  const roots: string[] = [
    path.join(os.homedir(), ".omp", "agent", "skills"),
    path.join(os.homedir(), ".omp", "agent", "managed-skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".config", "opencode", "skills"),
    path.join(os.homedir(), ".opencode", "skills"),
    path.join(H.agentDir, "skills"),
    path.join(H.agentDir, "managed-skills"),
  ];
  try {
    const customDirs = (H.settings.get("skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      roots.push(exp);
    }
  } catch {}
  for (const cwd of validDesktopProjects()) {
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      roots.push(
        path.join(cur, ".omp", "skills"),
        path.join(cur, ".agents", "skills"),
        path.join(cur, ".agent", "skills"),
        path.join(cur, ".claude", "skills"),
        path.join(cur, ".codex", "skills"),
        path.join(cur, ".opencode", "skills"),
        path.join(cur, ".github", "skills"),
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return roots;
}

// 前端传来的路径必须落在允许的三级根内；目录式定义归一到其入口文件（AGENT.md/SKILL.md）
export function resolveAssetFile(kind: AssetKind, p: unknown): string {
  const raw = String(p ?? "");
  let file = path.resolve(raw);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, kind === "skill" ? "SKILL.md" : "AGENT.md");
  if (kind === "mcp") {
    if (file.endsWith(".json") || file.endsWith(".toml")) {
      return file;
    }
    throw new Error(`仅支持 .json 或 .toml 配置文件: ${raw}`);
  }
  if (!file.endsWith(".md")) throw new Error(`仅支持 .md ${kind === "skill" ? "skill" : "agent"} 定义文件`);
  if (kind === "skill") {
    const ok = allSkillRoots().some((root) => {
      const rel = path.relative(root, file);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!ok) throw new Error(`路径不在允许的技能目录内: ${raw}`);
    return file;
  }
  const ok = assetRoots(kind).some((root) => {
    const rel = path.relative(root.dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!ok) throw new Error(`路径不在允许的 ${kind} 目录内: ${raw}`);
  return file;
}

async function listNamedDirs(dir: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

async function listNamedFiles(dir: string, ext: string): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name.replace(new RegExp(ext.replace(".", "\\.") + "$"), ""), path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

// 递归发现目录下的所有 SKILL.md 文件（支持嵌套如 research/blocked-page-recovery）
async function findSkillFiles(dir: string, maxDepth = 3): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".omp") continue;
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        const full = path.join(current, e.name);
        if (e.isDirectory() || e.isSymbolicLink()) {
          const skillMd = path.join(full, "SKILL.md");
          if (fs.existsSync(skillMd)) result.push(skillMd);
          await walk(full, depth + 1);
        }
      }
    } catch {}
  }
  const rootSkill = path.join(dir, "SKILL.md");
  if (fs.existsSync(rootSkill)) result.push(rootSkill);
  await walk(dir, 1);
  return Array.from(new Set(result));
}

// 解析单个 SKILL.md 文件为技能条目
async function parseSkillFile(filePath: string, provider: string, scope: string, isSkillDisabled: (name: string) => boolean) {
  try {
    const text = await readFile(filePath, "utf8");
    let name = path.basename(path.dirname(filePath));
    let description = "";
    const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const n = fmMatch[1].match(/^name:\s*(.+)$/m);
      if (n) name = n[1].trim().replace(/^["\x27]|["\x27]$/g, "");
      const d = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (d) description = d[1].trim().replace(/^["\x27]|["\x27]$/g, "");
    }
    if (!description) {
      const hMatch = text.match(/^#+\s+(.+)$/m);
      if (hMatch) description = hMatch[1].trim();
      else {
        const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").trim();
        const firstLine = body.split("\n").find((l) => l.trim().length > 0);
        if (firstLine) description = firstLine.trim();
      }
    }
    return {
      name,
      description,
      path: filePath,
      dir: path.dirname(filePath),
      provider,
      scope,
      enabled: !isSkillDisabled(name),
    };
  } catch {
    return null;
  }
}

// 依据 omp 源码 discovery 逻辑，扫描全局、Profile 及各项目的多来源技能
export async function loadAllSkillsScoped() {
  const disabled = new Set<string>(((H.settings.get("disabledExtensions") ?? []) as string[]));
  const ignored = new Set<string>(((H.settings.get("skills.ignoredSkills") ?? []) as string[]));
  const isSkillDisabled = (name: string) => disabled.has(`skill:${name}`) || ignored.has(name);

  // Profile 级目录源（含当前 Profile 的 skills、managed-skills 以及兼容外部用户级目录）
  const profileSources = [
    { dir: path.join(H.agentDir, "skills"), provider: "native" },
    { dir: path.join(H.agentDir, "managed-skills"), provider: "managed-skills" },
    { dir: path.join(os.homedir(), ".agents", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".agent", "skills"), provider: "agents" },
    { dir: path.join(os.homedir(), ".claude", "skills"), provider: "claude" },
    { dir: path.join(os.homedir(), ".codex", "skills"), provider: "codex" },
    { dir: path.join(os.homedir(), ".config", "opencode", "skills"), provider: "opencode" },
    { dir: path.join(os.homedir(), ".opencode", "skills"), provider: "opencode" },
  ];
  try {
    const customDirs = (H.settings.get("skills.customDirectories") ?? []) as string[];
    for (const cd of customDirs) {
      const exp = cd.startsWith("~/") ? path.join(os.homedir(), cd.slice(2)) : path.resolve(cd);
      profileSources.push({ dir: exp, provider: "custom" });
    }
  } catch {}

  const scanSources = async (sources: { dir: string; provider: string }[], scope: string) => {
    const skillMap = new Map<string, any>();
    for (const src of sources) {
      const files = await findSkillFiles(src.dir);
      for (const f of files) {
        const item = await parseSkillFile(f, src.provider, scope, isSkillDisabled);
        if (item && !skillMap.has(item.name)) {
          skillMap.set(item.name, item);
        }
      }
    }
    return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  };

  const scannedProfile = await scanSources(profileSources, "profile");
  const profileItemsMap = new Map<string, any>();
  for (const it of scannedProfile) profileItemsMap.set(it.name, it);

  try {
    const capRes = await loadCapability<any>("skills", { cwd: H.agentDir, includeDisabled: true });
    for (const s of capRes.all ?? []) {
      if ((s.level === "user" || s._source?.level === "user") && !profileItemsMap.has(s.name)) {
        const p = s.path || s._source?.path;
        if (p) {
          profileItemsMap.set(s.name, {
            name: s.name,
            description: s.frontmatter?.description || "",
            path: p,
            dir: path.dirname(p),
            provider: s._source?.provider || "native",
            scope: "profile",
            enabled: !isSkillDisabled(s.name),
          });
        }
      }
    }
  } catch {}
  const profileItems = Array.from(profileItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const projects: { cwd: string; name: string; dir: string; skills: any[] }[] = [];
  for (const cwd of validDesktopProjects()) {
    const pSources: { dir: string; provider: string }[] = [];
    let cur = path.resolve(cwd);
    const root = path.parse(cur).root;
    while (cur && cur !== os.homedir() && cur !== root) {
      pSources.push(
        { dir: path.join(cur, ".omp", "skills"), provider: "native" },
        { dir: path.join(cur, ".agents", "skills"), provider: "agents" },
        { dir: path.join(cur, ".agent", "skills"), provider: "agents" },
        { dir: path.join(cur, ".claude", "skills"), provider: "claude" },
        { dir: path.join(cur, ".codex", "skills"), provider: "codex" },
        { dir: path.join(cur, ".opencode", "skills"), provider: "opencode" },
        { dir: path.join(cur, ".github", "skills"), provider: "github" },
      );
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const scannedProj = await scanSources(pSources, `project:${cwd}`);
    const projItemsMap = new Map<string, any>();
    for (const it of scannedProj) projItemsMap.set(it.name, it);

    try {
      const pCapRes = await loadCapability<any>("skills", { cwd, includeDisabled: true });
      for (const s of pCapRes.all ?? []) {
        if ((s.level === "project" || s._source?.level === "project") && !projItemsMap.has(s.name)) {
          const p = s.path || s._source?.path;
          if (p) {
            projItemsMap.set(s.name, {
              name: s.name,
              description: s.frontmatter?.description || "",
              path: p,
              dir: path.dirname(p),
              provider: s._source?.provider || "native",
              scope: `project:${cwd}`,
              enabled: !isSkillDisabled(s.name),
            });
          }
        }
      }
    } catch {}

    const skills = Array.from(projItemsMap.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const primaryDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp", "skills");
    projects.push({ cwd, name: path.basename(cwd), dir: primaryDir, skills });
  }

  return {
    global: profileItems, // 向后兼容
    profile: profileItems,
    projects,
    globalDir: path.join(H.agentDir, "skills"), // 向后兼容
    profileDir: path.join(H.agentDir, "skills"),
    profileName: H.currentProfile,
  };
}

// MCP 健康探测缓存（60秒内避免重复建连）。曾嵌在 listAgentAssets 函数体内，导致
// server 层 set_mcp_server_enabled / test_mcp_server 对它的引用悬空（TS2304）——拆分时提升为模块级。
export const mcpHealthCache = new Map<string, { status: "connected" | "error"; error?: string; timestamp: number }>();

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
}): Promise<{ status: "connected" | "error"; error?: string }> {
  const cached = mcpHealthCache.get(server.name);
  if (cached && Date.now() - cached.timestamp < 60_000) {
    return { status: cached.status, error: cached.error };
  }

  const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
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
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("连接超时")), 2000)
      ),
    ]);
    await disconnectServer(conn);
    const res = { status: "connected" as const };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  } catch (err: any) {
    let msg = err?.message || String(err);
    if (msg.includes("Executable not found in $PATH") || msg.includes("ENOENT") || msg.includes("spawn")) {
      msg = "MCP 进程启动失败。";
    } else if (msg.includes("protocol") || msg.includes("version") || msg.includes("negotiation") || msg.includes("UnsupportedProtocolVersion")) {
      msg = "MCP 协议协商失败，服务器版本可能不兼容。可尝试编辑该服务器，将协议版本切换为「兼容旧版」。";
    } else if (msg.includes("ECONNREFUSED")) {
      msg = "MCP 连接失败：目标服务未启动或端口不可达。";
    } else if (msg.includes("连接超时")) {
      msg = "MCP 连接超时：未在 2 秒内响应。";
    }
    const res = { status: "error" as const, error: msg };
    mcpHealthCache.set(server.name, { ...res, timestamp: Date.now() });
    return res;
  }
}

// 依据 omp 源码的 mcps capability，发现并整合全局、Profile 及各工作区项目的全部 MCP 服务器
export async function loadAllMcpScoped() {
  const userMcpPath = path.join(H.agentDir, "mcp.json");
  const [disabledList, forcedList] = await Promise.all([
    readDisabledServers(userMcpPath).catch(() => [] as string[]),
    readEnabledServers(userMcpPath).catch(() => [] as string[]),
  ]);
  const disabledSet = new Set(disabledList);
  const forcedSet = new Set(forcedList);

  const isServerEnabled = (name: string, rawEnabled?: boolean) => {
    if (disabledSet.has(name)) return false;
    if (rawEnabled === false && !forcedSet.has(name)) return false;
    return true;
  };

  type McpServerItem = {
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
  };

  const allServersMap = new Map<string, McpServerItem>();

  // 1. 用户级发现（当前 Profile 及全局外部源，如 ~/.claude.json、~/.cursor/mcp.json、~/.codex/config.toml 等）
  try {
    const userRes = await loadCapability<any>("mcps", { cwd: H.agentDir, includeDisabled: true });
    for (const s of userRes.items) {
      const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
      const enabled = isServerEnabled(s.name, s.enabled);
      allServersMap.set(s.name, {
        name: s.name,
        transport,
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        env: s.env,
        cwd: s.cwd,
        enabled,
        source: {
          provider: s._source?.provider ?? "native",
          providerName: s._source?.providerName ?? "OMP",
          path: s._source?.path ?? userMcpPath,
          level: s._source?.level ?? "user",
        },
        scope: s._source?.level === "project" ? "project" : "profile",
        status: enabled ? "unknown" : "disabled",
      });
    }
  } catch (err) {
    process.stderr.write(`[host] MCP 用户级发现失败: ${err}\n`);
  }

  // 2. 项目工作区级发现（各个桌面打开的项目）
  const projectScopeList: { cwd: string; name: string; dir: string; count: number }[] = [];
  for (const cwd of validDesktopProjects()) {
    let count = 0;
    try {
      const projRes = await loadCapability<any>("mcps", { cwd, includeDisabled: true });
      for (const s of projRes.items) {
        const isProject = s._source?.level === "project";
        const transport = s.transport ?? (s.command ? "stdio" : s.url ? "http" : "stdio");
        const enabled = isServerEnabled(s.name, s.enabled);
        const item: McpServerItem = {
          name: s.name,
          transport,
          command: s.command,
          args: s.args,
          url: s.url,
          headers: s.headers,
          env: s.env,
          cwd: s.cwd ?? cwd,
          enabled,
          source: {
            provider: s._source?.provider ?? "native",
            providerName: s._source?.providerName ?? "项目配置",
            path: s._source?.path ?? path.join(cwd, ".omp", "mcp.json"),
            level: s._source?.level ?? "project",
          },
          scope: isProject ? `project:${cwd}` : "profile",
          projectName: path.basename(cwd),
          status: enabled ? "unknown" : "disabled",
        };
        allServersMap.set(s.name, item);
        count++;
      }
    } catch (err) {
      process.stderr.write(`[host] MCP 项目级发现失败 (${cwd}): ${err}\n`);
    }

    // 额外兼容如 etower-agent 的 config/mcp-servers.json
    const etowerFile = path.join(cwd, "config", "mcp-servers.json");
    if (fs.existsSync(etowerFile)) {
      try {
        const raw = JSON.parse(await readFile(etowerFile, "utf8"));
        for (const [name, cfg] of Object.entries<any>(raw)) {
          if (!allServersMap.has(name)) {
            const transport = (cfg.url ? "http" : "stdio") as "stdio" | "http";
            const enabled = isServerEnabled(name, cfg.enabled);
            allServersMap.set(name, {
              name,
              transport,
              command: cfg.command,
              args: cfg.args,
              url: cfg.url,
              headers: cfg.headers,
              env: cfg.env,
              cwd,
              enabled,
              source: {
                provider: "etower",
                providerName: "项目配置",
                path: etowerFile,
                level: "project",
              },
              scope: `project:${cwd}`,
              projectName: path.basename(cwd),
              status: enabled ? "unknown" : "disabled",
            });
            count++;
          }
        }
      } catch {}
    }

    const primaryOmpDir = nearestProjectOmpDir(cwd) ?? path.join(path.resolve(cwd), ".omp");
    projectScopeList.push({ cwd, name: path.basename(cwd), dir: primaryOmpDir, count });
  }

  const serverList = Array.from(allServersMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  // 3. 并发健康检测（对启用状态的服务器发起快速探测，超时 2s）
  const enabledServers = serverList.filter((s) => s.enabled);
  const probeResults = await Promise.all(
    enabledServers.map(async (s) => {
      const probe = await probeMcpServerHealth(s);
      return { name: s.name, probe };
    })
  );
  const probeMap = new Map(probeResults.map((r) => [r.name, r.probe]));

  for (const s of serverList) {
    if (s.enabled) {
      const p = probeMap.get(s.name);
      if (p) {
        s.status = p.status;
        s.error = p.error;
      } else {
        s.status = "connected";
      }
    } else {
      s.status = "disabled";
      s.error = undefined;
    }
  }

  // 兼容原有资产字段
  const mcpProfile = { path: userMcpPath, servers: serverList.map((s) => ({ name: s.name, command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "" })) };
  const mcpProjects = projectScopeList.map((p) => ({
    cwd: p.cwd,
    name: p.name,
    path: path.join(p.dir, "mcp.json"),
    servers: serverList.filter((s) => s.scope === `project:${p.cwd}`).map((s) => ({ name: s.name, command: [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || s.url || "" })),
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
    global: mcpProfile, // 向后兼容
    profile: mcpProfile,
    projects: mcpProjects,
    profileName: H.currentProfile,
  };
}

export async function listAgentAssets() {
  const memoriesDir = path.join(H.agentDir, "memories");
  const commands = await listNamedFiles(path.join(H.agentDir, "commands"), ".md");
  // agent 定义按两级返回：当前 profile / 各桌面项目
  interface AssetListPayload {
    global?: any[];
    profile: any[];
    projects: { cwd: string; name: string; dir: string; agents?: any[] }[];
    globalDir?: string;
    profileDir: string;
    profileName?: string;
  }
  const loadScopedAgents = async (): Promise<AssetListPayload> => {
    const payload: AssetListPayload = {
      profile: [],
      projects: [],
      profileDir: path.join(H.agentDir, "agents"),
    };
    for (const r of assetRoots("agent")) {
      const items = [];
      for (const d of await listNamedDirs(r.dir)) items.push({ name: d.name, path: d.path, description: await agentFileDescription(path.join(d.path, "AGENT.md")) });
      for (const f of await listNamedFiles(r.dir, ".md")) items.push({ name: f.name, path: f.path, description: await agentFileDescription(f.path) });
      if (r.scope === "profile") payload.profile = items;
      else payload.projects.push({ cwd: r.cwd!, name: path.basename(r.cwd!), dir: r.dir, agents: items });
    }
    payload.global = payload.profile;
    payload.globalDir = payload.profileDir;
    payload.profileName = H.currentProfile;
    return payload;
  };
  const agents = await loadScopedAgents();
  const skills = await loadAllSkillsScoped();
  const mcp = await loadAllMcpScoped();
  const hooks: { name: string; path: string; phase: string }[] = [];
  for (const phase of ["pre", "post"]) {
    for (const f of await listNamedFiles(path.join(H.agentDir, "hooks", phase), ".ts")) hooks.push({ ...f, phase });
    for (const f of await listNamedFiles(path.join(H.agentDir, "hooks", phase), ".js")) hooks.push({ ...f, phase });
  }
  // 记忆文件名是 omp 的 encodeProjectPath（cwd 去掉前导斜杠后把 / \ : 换成 -，首尾加 --），
  const validProjects = validDesktopProjects();
  const encodeProjectPath = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  let memories: { name: string; path: string; project?: string }[] = [];
  try {
    const entries = await readdir(memoriesDir, { withFileTypes: true });
    memories = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => {
        const cwd = validProjects.find((c) => encodeProjectPath(c) === e.name);
        return { name: e.name, path: path.join(memoriesDir, e.name), project: cwd ? path.basename(cwd) : undefined };
      })
      .filter((m) => m.project !== undefined);
  } catch {}
  return {
    memories,
    skills,
    commands,
    agents,
    hooks,
    mcp,
    plugins: [] as { name: string }[],
    flags: { enableMCP: false, disableExtensionDiscovery: true, computerEnabled: !!H.settings.get("computer.enabled") },
  };
}
