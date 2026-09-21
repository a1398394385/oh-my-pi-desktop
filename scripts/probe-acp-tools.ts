// 探针：ACP 压缩全链路（不发真模型请求）。
// 1) 5 个工具注册进会话（customTools + extensions 参数被 SDK 接受）
// 2) transformContext 纯函数往返：ref 注入 → compress 建块 → 视图替换 →
//    配对完整 → decompress 还原 → ref 幂等
import { setProfile } from "@oh-my-pi/pi-utils";

// （动态 import 是必须的：coding-agent 模块在 import 时读取 agentDir，setProfile 必须先行——
// 与 host/bootstrap.ts 的加载顺序闸门同因，见该文件头注释。）
setProfile("omp-desktop");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
	await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AcpSessionState } from "../host/acp-state.ts";
import { transformContext } from "../host/acp-context.ts";
import { createAcpCompressTools } from "../host/acp-tools.ts";

// ---- 1) 会话注册面 --------------------------------------------------------

const cwd = os.homedir();
const agentDir = os.homedir() + "/.omp/profiles/omp-desktop/agent";
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });

const state = new AcpSessionState();
const manager = SessionManager.create(cwd);
const { session } = await createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	settings,
	agentRegistry: new AgentRegistry(),
	sessionManager: manager,
	customTools: createAcpCompressTools(state),
	extensions: [() => {}], // extensions 参数形状被接受即可；真实扩展在 host.ts 接线
	disableExtensionDiscovery: true,
	enableMCP: false,
});

const tools: Array<{ name: string; description?: string; parameters?: unknown; execute?: unknown }> =
	(session as unknown as { agent?: { state?: { tools?: unknown[] } } }).agent?.state?.tools ?? [];
const names = tools.map((t) => t.name);
const REQUIRED = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"];
const missing = REQUIRED.filter((n) => !names.includes(n));
if (missing.length > 0) throw new Error(`缺少 ACP 工具: ${missing.join(", ")}`);
console.log(`PASS 1: 会话 ${names.length} 个工具中 5 个 ACP 工具全部注册`);

// ---- 2) 视图往返 ----------------------------------------------------------

const t = (ms: number): number => 1700000000000 + ms;
const base: AgentMessage[] = [
	{ role: "user", content: "探索一下认证系统的结构", timestamp: t(1) },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "我来看下目录结构" },
			{ type: "toolCall", id: "call-1", tool: "read" },
		],
		api: "anthropic",
		provider: "x",
		model: "test",
		timestamp: t(2),
	} as unknown as AgentMessage,
	{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "src/auth/…（长输出）" }], isError: false, timestamp: t(3) } as unknown as AgentMessage,
	{ role: "user", content: "总结一下", timestamp: t(4) },
];

// 2a) 首次变换：ref 注入
let view = transformContext(state, structuredClone(base));
const viewText = view.map((m) => JSON.stringify(m)).join("\n");
if (!viewText.includes("<dcp-message-id>m00001</dcp-message-id>")) throw new Error("ref m00001 未注入");
if (!viewText.includes("<dcp-message-id>m00004</dcp-message-id>")) throw new Error("ref m00004 未注入");
if (state.lastOriginal.length !== 4) throw new Error("lastOriginal 未捕获");
console.log("PASS 2a: 4 条消息全部注入 ref（m00001..m00004）");

// 2b) 幂等：同一视图再变换一次，标签不叠加
view = transformContext(state, structuredClone(base));
if (viewText.split("<dcp-message-id>").length !== view.map((m) => JSON.stringify(m)).join("\n").split("<dcp-message-id>").length)
	throw new Error("ref 标签在二次变换后叠加了");
console.log("PASS 2b: ref 注入幂等（二次变换标签数不变）");

// 2c) compress m00001..m00002（会触发配对闭合：call-1 的 result 在 m3 → 扩到 0..2）
const compress = createAcpCompressTools(state).find((x) => x.name === "compress")!;
const res = await compress.execute("probe-c1", {
	content: [{ topic: "Auth exploration", startId: "m00001", endId: "m00002", summary: "探索了 src/auth 结构，read 输出了目录树。" }],
}, undefined, undefined, {} as never);
const ctext = String((res.content as Array<{ text?: string }>)[0]?.text ?? "");
if (!ctext.includes("b0")) throw new Error(`compress 未建块: ${ctext}`);
console.log(`PASS 2c: compress m00001..m00002 → ${ctext.split("\n")[0]}`);

// 2d) 变换后：区间 0..2 被替换为摘要块消息，m00004(原 idx3) ref 保持
view = transformContext(state, structuredClone(base));
if (view.length !== 2) throw new Error(`替换后视图应为 2 条（摘要+最后user），实际 ${view.length}`);
const summaryMsg = view[0] as { role?: string; content?: unknown };
if (summaryMsg.role !== "user" || !String(summaryMsg.content).startsWith("[Compressed conversation section]"))
	throw new Error("首条不是摘要块消息");
if (!String(summaryMsg.content).includes("(b0)")) throw new Error("摘要块缺 (b0) 标记");
const lastMsg = JSON.stringify(view[1]);
if (!lastMsg.includes("<dcp-message-id>m00004</dcp-message-id>")) throw new Error("压缩后后续消息 ref 漂移（应仍为 m00004）");
console.log("PASS 2d: 压缩区间替换为摘要块，后续 ref 保持 m00004");

// 2e) 配对完整：视图中不允许出现孤立 toolCall / toolResult
const flat = view.map((m) => JSON.stringify(m)).join("");
if (flat.includes("call-1")) throw new Error("压缩后视图仍含 call-1 碎片（配对未闭合）");
console.log("PASS 2e: 压缩范围工具事务闭合（无孤立 call/result 碎片）");

// 2f) decompress b0 → 还原
const decompress = createAcpCompressTools(state).find((x) => x.name === "decompress")!;
await decompress.execute("probe-d1", { blockId: "b0" }, undefined, undefined, {} as never);
view = transformContext(state, structuredClone(base));
if (view.length !== 4) throw new Error(`decompress 后视图应为 4 条，实际 ${view.length}`);
const restored = view.map((m) => JSON.stringify(m)).join("");
if (!restored.includes("探索一下认证系统的结构")) throw new Error("原文未还原");
console.log("PASS 2f: decompress b0 后 4 条原文还原");

// 2g) search_context / acp_status / recap 在有块状态下工作
await compress.execute("probe-c2", {
	content: [{ topic: "Auth exploration", startId: "m00001", endId: "m00003", summary: "认证系统探索：目录结构 read 输出，含 jwt 与 session 模块。" }],
}, undefined, undefined, {} as never);
const search = createAcpCompressTools(state).find((x) => x.name === "search_context")!;
const sres = await search.execute("probe-s1", { query: "认证 目录" }, undefined, undefined, {} as never);
const stext = String((sres.content as Array<{ text?: string }>)[0]?.text ?? "");
if (!stext.includes("b1")) throw new Error(`search_context 未命中: ${stext}`);
console.log(`PASS 2g: search_context 命中 → ${stext.split("\n")[0]}`);

const status = createAcpCompressTools(state).find((x) => x.name === "acp_status")!;
const stat = await status.execute("probe-st", { scope: "compressed" }, undefined, undefined, {} as never);
if (!String((stat.content as Array<{ text?: string }>)[0]?.text).includes("b1")) throw new Error("acp_status 未列出块");
console.log("PASS 2h: acp_status(scope:compressed) 列出块");

// 2i) 宿主 compaction 模拟：前缀被折叠 → ref 全量重编不崩
const folded: AgentMessage[] = [
	{ role: "user", content: "[宿主摘要] 之前聊了认证系统", synthetic: true, timestamp: t(99) },
	{ role: "user", content: "新任务", timestamp: t(100) },
];
view = transformContext(state, structuredClone(folded));
const foldedText = view.map((m) => JSON.stringify(m)).join("");
if (!foldedText.includes("m00001") || !foldedText.includes("m00002")) throw new Error("折叠后未重编 ref");
console.log("PASS 2i: 视图前缀折叠后 ref 全量重编（块原文定位降级不崩溃）");

// ---- 3) P1：ACP 工具调用硬保护 ----

const state3 = new AcpSessionState();
const withAcp: AgentMessage[] = [
	{ role: "user", content: "任务甲", timestamp: t(10) },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "压缩旧范围" },
			{ type: "toolCall", id: "call-a", tool: "compress" },
		],
		api: "anthropic",
		provider: "x",
		model: "test",
		timestamp: t(11),
	} as unknown as AgentMessage,
	{ role: "toolResult", toolCallId: "call-a", toolName: "compress", content: [{ type: "text", text: "📦 [ACP] Compressed ..." }], isError: false, timestamp: t(12) } as unknown as AgentMessage,
	{ role: "user", content: "任务乙", timestamp: t(13) },
];
let v3 = transformContext(state3, structuredClone(withAcp));
const v3flat = v3.map((m) => JSON.stringify(m)).join("");
if (v3flat.includes("<dcp-message-id>m00003")) throw new Error("compress 工具结果不应带 ref 标签");
if (!v3flat.includes("<dcp-message-id>m00004")) throw new Error("后续消息 ref 应保持注入");
console.log("PASS 3a: ACP 工具结果占号但不注入 ref 标签（m00003 隐藏，m00004 可见）");

const compress3 = createAcpCompressTools(state3).find((x) => x.name === "compress")!;
const r3 = await compress3.execute("p3", {
	content: [{ topic: "含保护调用", startId: "m00001", endId: "m00004", summary: "整体压缩" }],
}, undefined, undefined, {} as never);
const r3text = String((r3.content as Array<{ text?: string }>)[0]?.text ?? "");
if (!r3text.includes("protected")) throw new Error(`覆盖 ACP 工具调用未被拒绝: ${r3text}`);
console.log(`PASS 3b: compress 覆盖 ACP 工具调用被硬保护拒绝`);

// ---- 4) P1：块消费占位 ----

const state4 = new AcpSessionState();
transformContext(state4, structuredClone(base));
const compress4 = createAcpCompressTools(state4).find((x) => x.name === "compress")!;
await compress4.execute("p4a", {
	content: [{ topic: "First block", startId: "m00001", endId: "m00001", summary: "第一段摘要" }],
}, undefined, undefined, {} as never);
// 第二块完全覆盖第一块 → b0 被消费，b1 summary 前缀应含消费清单
await compress4.execute("p4b", {
	content: [{ topic: "Wider", startId: "m00001", endId: "m00003", summary: "更宽范围的摘要" }],
}, undefined, undefined, {} as never);
const b1 = state4.blocks.get(1)!;
if (!b1.summary.startsWith('[Consumed blocks: b0 "First block"]')) throw new Error(`消费清单缺失: ${b1.summary.slice(0, 80)}`);
if (!state4.blocks.get(0)!.active) {
	// b0 被消费应 inactive
} else {
	throw new Error("被消费的 b0 仍为 active");
}
console.log('PASS 4: 覆盖压缩注入消费清单（[Consumed blocks: b0 "First block"]），旧块转 inactive');

// ---- 5) P2：nudge（仅出境，不进历史） ----

const state5 = new AcpSessionState();
state5.modelContextWindow = 60; // 极小窗口：base 视图文本必然超 55%
let v5 = transformContext(state5, structuredClone(base));
const nudgeMsg = v5[v5.length - 1] as { role?: string; content?: unknown };
const nudgeText = typeof nudgeMsg?.content === "string" ? nudgeMsg.content : "";
if (!nudgeText.includes("[ACP context nudge]")) throw new Error("超限时未注入 nudge");
if (!/~\d+%/.test(nudgeText)) throw new Error(`nudge 应含 5% 档取整用量: ${nudgeText.slice(0, 120)}`);
if (state5.lastOriginal.some((m) => JSON.stringify(m).includes("[ACP context nudge]"))) throw new Error("nudge 泄漏进了 lastOriginal（应仅出境）");
console.log("PASS 5a: 用量超 maxContextLimit 注入请求级 nudge，不进原始视图");

state5.modelContextWindow = 1_000_000; // 大窗口：不触发
v5 = transformContext(state5, structuredClone(base));
const last5 = v5[v5.length - 1] as { role?: string; content?: unknown };
if (String((last5 as { content?: unknown }).content ?? "").includes("[ACP context nudge]")) throw new Error("未超限却注入了 nudge");
console.log("PASS 5b: 用量低于阈值不注入");

console.log("\n=== 探针全部通过 ===");

// ---- 6) contextWindow 固定值配置解析 ----
import { parseAcpContextWindow } from "../host/acp-state.ts";
const cwCases: Array<[unknown, number]> = [
	[2000000, 2000000], ["200K", 200000], ["1M", 1000000], ["2m", 2000000], [" 1.5M ", 1500000],
	["55%", 0], [-5, 0], ["abc", 0], [undefined, 0],
];
for (const [cwInput, cwWant] of cwCases) {
	const cwGot = parseAcpContextWindow(cwInput);
	if (cwGot !== cwWant) throw new Error(`parseAcpContextWindow(${JSON.stringify(cwInput)}) = ${cwGot}, want ${cwWant}`);
}
console.log("PASS 6: contextWindow 解析 9 组用例全过（数字/K/M/大小写/非法值）");
