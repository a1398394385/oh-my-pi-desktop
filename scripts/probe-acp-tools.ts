// 探针：断言 ACP 压缩工具面（compress/decompress/search_context/acp_status/acp_context_recap）
// 已通过 createAgentSession({ customTools }) 注册进会话，且 execute 返回适配层回执。
// 不发真模型请求——只验证工具注册与调用面。
// （动态 import 是必须的：coding-agent 模块在 import 时读取 agentDir，setProfile 必须先行——
// 与 host/bootstrap.ts 的加载顺序闸门同因，见该文件头注释。）
import { setProfile } from "@oh-my-pi/pi-utils";
setProfile("omp-desktop");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";
import { createAcpCompressTools } from "../host/acp-tools.ts";

const cwd = os.homedir();
const agentDir = process.env.OMP_DESKTOP_AGENT_DIR ?? os.homedir() + "/.omp/profiles/omp-desktop/agent";
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });

const manager = SessionManager.create(cwd);
const { session } = await createAgentSession({
  cwd,
  authStorage,
  modelRegistry,
  settings,
  agentRegistry: new AgentRegistry(),
  sessionManager: manager,
  customTools: createAcpCompressTools(),
  disableExtensionDiscovery: true,
  enableMCP: false,
});

// 工具列表路径：agent.state.tools（agent-session 的工具注册面）
const tools: Array<{ name: string; description?: string; parameters?: unknown; execute?: unknown }> =
  (session as unknown as { agent?: { state?: { tools?: unknown[] } } }).agent?.state?.tools ??
  ([] as unknown[]);
const names = tools.map((t) => t.name);
console.log(`会话工具 ${names.length} 个，ACP 相关: ${names.filter((n) => /acp|compress|search_context/.test(n)).join(", ")}`);

const REQUIRED = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"];
const missing = REQUIRED.filter((n) => !names.includes(n));
if (missing.length > 0) throw new Error(`缺少 ACP 工具: ${missing.join(", ")}`);
console.log("PASS: 全部 5 个 ACP 压缩工具已注册到会话");

// 工具对象直查：schema 与描述在场
for (const t of tools.filter((t) => REQUIRED.includes(t.name))) {
  if (!t.description || t.description.length < 100) throw new Error(`${t.name}: 描述缺失或过短`);
  if (!t.parameters) throw new Error(`${t.name}: 参数 schema 缺失`);
  if (typeof t.execute !== "function") throw new Error(`${t.name}: execute 不是函数`);
}
console.log("PASS: 每个工具都带原版描述、参数 schema 与 execute");

// 执行面抽查：compress 的参数校验分支 + acp_status 的真实概况回执
const acpTools = createAcpCompressTools();
const compress = acpTools.find((t) => t.name === "compress")!;
const bad = await compress.execute("probe-1", { content: [] }, undefined, undefined, {} as never);
if (!bad.content[0] || !String(bad.content[0].text).includes("Error")) throw new Error("compress 空参数未走校验分支");
console.log("PASS: compress 参数校验分支生效 →", String(bad.content[0].text));

const status = acpTools.find((t) => t.name === "acp_status")!;
const ok = await status.execute("probe-2", {}, undefined, undefined, {
  sessionManager: manager,
} as never);
const statusText = String(ok.content[0]?.text ?? "");
if (!statusText.includes("[ACP omp-desktop adapter]")) throw new Error("acp_status 未返回适配层回执");
console.log("PASS: acp_status 返回适配层回执（含会话概况）");
console.log("\n=== 探针全部通过 ===");
