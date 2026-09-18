// 探针：验证 npm 包装配链路（import → 底座 → createAgentSession inMemory → dispose）
// 不发真模型请求，只验证进程内会话能建起来。
import {
  createAgentSession,
  SessionManager,
  Settings,
  discoverAuthStorage,
  ModelRegistry,
  AgentRegistry,
} from "@oh-my-pi/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const cwd = os.homedir();
const agentDir = path.join(cwd, ".omp", "agent");

const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });

const available = modelRegistry.getAvailable();
console.log(`可用模型 ${available.length} 个，示例:`, available.slice(0, 3).map((m) => `${m.provider}/${m.id}`));

const { session, modelFallbackMessage } = await createAgentSession({
  cwd,
  authStorage,
  modelRegistry,
  settings,
  agentRegistry: new AgentRegistry(),
  sessionManager: SessionManager.inMemory(),
  disableExtensionDiscovery: true,
  enableMCP: false,
});
if (modelFallbackMessage) console.log("模型回退提示:", modelFallbackMessage);
console.log("session 建立:", typeof session.subscribe === "function", "sessionFile:", session.sessionFile);

await session.dispose();
console.log("probe 通过 ✓");
process.exit(0);
