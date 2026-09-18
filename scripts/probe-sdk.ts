// 探针：验证 profile 隔离 + 文件后端 + open 恢复 + getEntries 历史读取的完整组合。
// 关键点：setProfile 必须先于 coding-agent 的 import（其模块 import 时读取 agentDir）。
import { setProfile, getAgentDir } from "@oh-my-pi/pi-utils";

setProfile("omp-desktop");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";
import path from "node:path";

const cwd = os.homedir();
const agentDir = getAgentDir();
console.log("agentDir:", agentDir);
if (!agentDir.includes("profiles/omp-desktop")) throw new Error("profile 未生效");

// 底座（走 profile 的认证）
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });
const available = modelRegistry.getAvailable();
console.log(`可用模型 ${available.length} 个`);
if (!available.some((m) => m.id === "deepseek-flash")) throw new Error("profile 下没有 deepseek-flash 认证");

// listAll：应列出 profile sessions 目录下所有 project 的会话
const all = await SessionManager.listAll();
console.log(`listAll: ${all.length} 个会话，project 数 ${new Set(all.map((s) => s.cwd)).size}`);
if (all.length > 0) {
  const sample = all[0];
  console.log(`  示例: cwd=${sample.cwd} title=${sample.title ?? sample.firstMessage.slice(0, 30)} msgs=${sample.messageCount}`);
  if (!sample.path.startsWith(agentDir)) throw new Error("listAll 返回了 profile 之外的路径: " + sample.path);
}

// 文件后端新建 + open 恢复 + getEntries
const manager = SessionManager.create(cwd);
const { session } = await createAgentSession({
  cwd,
  authStorage,
  modelRegistry,
  settings,
  agentRegistry: new AgentRegistry(),
  sessionManager: manager,
  disableExtensionDiscovery: true,
  enableMCP: false,
});
const file = session.sessionFile;
console.log("新建落盘:", file);
if (!file?.startsWith(agentDir)) throw new Error("落盘路径不在 profile 下");

// open 恢复 + 喂给 createAgentSession（本次探针的关键断言）
const reopened = await SessionManager.open(file);
const { session: session2 } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  agentRegistry: new AgentRegistry(),
  sessionManager: reopened,
  disableExtensionDiscovery: true,
  enableMCP: false,
});
console.log("open→createAgentSession 通过, 恢复 cwd:", session2.sessionFile === file ? file : session2.sessionFile);
const entries = reopened.getEntries();
console.log(`getEntries: ${entries.length} 条`);
const msgEntry = entries.find((e: any) => e.type === "message");
if (msgEntry) console.log("示例消息 role:", msgEntry.message.role, "content 类型:", typeof msgEntry.message.content);

await session.dispose();
await session2.dispose();
console.log("probe 通过 ✓");
process.exit(0);
