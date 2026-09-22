// P0 验证探针：真实模型请求路径上，内联 extensions 的 context handler 是否触发。
//
// 断言分层：
//   硬断言（与模型行为无关）：
//     H1  context handler 被调用（capturedView 非空）
//     H2  发给模型的视图含 <dcp-message-id> 标签（ref 注入真实生效）
//   软断言（模型配合度）：
//     S1  模型回复中能报出 m00001（模型确实看到了标签）
//
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/probe-acp-live.ts
// （认证走 omp-desktop profile，与 probe-sdk.ts 同路径）
import { setProfile } from "@oh-my-pi/pi-utils";

// （动态 import 是必须的：coding-agent 模块在 import 时读取 agentDir，setProfile 必须先行）
setProfile("omp-desktop");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
	await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AcpSessionState } from "../host/acp-state.ts";
import { transformContext } from "../host/acp-context.ts";
import { createAcpCompressTools } from "../host/acp-tools.ts";

const modelPattern = process.env.OMP_DESKTOP_MODEL ?? "deepseek/deepseek-flash";
const cwd = os.homedir();
const agentDir = os.homedir() + "/.omp/profiles/omp-desktop/agent";
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const model = modelRegistry.getAvailable().find((m) => `${m.provider}/${m.id}` === modelPattern);
if (!model) throw new Error(`模型 ${modelPattern} 不可用（profile 认证里没有）`);
const settings = await Settings.init({ cwd, agentDir });

const state = new AcpSessionState();
let capturedView: AgentMessage[] | null = null;

const { session } = await createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	settings,
	model,
	agentRegistry: new AgentRegistry(),
	sessionManager: SessionManager.inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd),
	customTools: createAcpCompressTools(state) as never,
	extensions: [
		(pi: {
			on: (
				event: "context",
				handler: (ev: { messages: AgentMessage[] }) => { messages: AgentMessage[] },
			) => void;
		}) => {
			pi.on("context", (ev) => {
				const out = transformContext(state, ev.messages);
				capturedView = out;
				return { messages: out };
			});
		},
	],
	disableExtensionDiscovery: true,
	enableMCP: false,
	hasUI: true,
});

console.log(`模型: ${model.provider}/${model.id}，发送测试 prompt…`);
await session.prompt(
	"Do not call any tools. Look at the conversation messages themselves: list every <dcp-message-id> tag value you can see (just the m-numbers, one per line).",
);

// H1: handler 被调用过
if (!capturedView) throw new Error("H1 失败: context handler 从未被调用——内联 extensions 不在该请求路径上触发");
console.log(`PASS H1: context handler 触发（捕获视图 ${capturedView.length} 条消息）`);

// H2: 出境视图含 ref 标签
const flat = capturedView.map((m) => JSON.stringify(m)).join("");
if (!flat.includes("<dcp-message-id>")) throw new Error("H2 失败: 出境视图没有 ref 标签");
const tags = flat.match(/m\d{5}/g) ?? [];
console.log(`PASS H2: 出境视图含 ref 标签: ${[...new Set(tags)].join(", ")}`);

// S1: 模型看见了
const msgs = (session as unknown as { agent?: { state?: { messages?: AgentMessage[] } } }).agent?.state?.messages ?? [];
const lastAssistant = [...msgs].reverse().find((m) => (m as { role?: string }).role === "assistant");
const reply = lastAssistant ? JSON.stringify(lastAssistant) : "";
if (/m\d{5}/.test(reply)) {
	console.log(`PASS S1: 模型回复中报出了 ref → ${reply.match(/m\d{5}/g)?.join(", ")}`);
} else {
	console.log(`WARN S1: 模型未报出 ref（可能不配合复述，但 H1/H2 已证明注入生效）。回复片段: ${reply.slice(0, 200)}`);
}

console.log("\n=== P0 验证通过：context 事件在真实请求路径触发，ref 注入到达模型 ===");
process.exit(0);
