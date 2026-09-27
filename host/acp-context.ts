// ACP 视图变换：context 事件内联扩展。
//
// 每轮 LLM 请求，omp 从 journal 重建完整原始视图并触发 context 事件（深拷贝、
// 安全改写、只影响本次请求、不写回）。我们在同一事件里完成三件事：
//   1. ref 刷新（前缀指纹匹配 → 保号续号；宿主 compaction 折叠 → 全量重编）
//   2. 活跃压缩块定位 + 区间替换（原始消息 → 单条摘要 user 消息）
//   3. ref 标签注入（<dcp-message-id>mNNNNN</dcp-message-id>，幂等）
//
// ref、块定位、compress 取原文全部来自同一视图坐标系（state.lastOriginal），
// 不读 journal —— 这是 billion-context-pi 在 omp 上漂移翻车后本实现绕开它的
// 根本姿势：映射只在单次请求视图内自洽，永不跨坐标系。
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AcpSessionState } from "./acp-state.ts";
import { ACP_TOOL_NAMES } from "./acp-state.ts";
import { messageText } from "./acp-state.ts";

export const REF_TAG_RE = /<dcp-message-id>m\d{1,5}<\/dcp-message-id>\n?/g;

/** 摘要块消息的固定头部（与 opencode-acp 的标记一致）。 */
function summaryMessage(blockId: number, topic: string, summary: string): AgentMessage {
	const text = [
		"[Compressed conversation section]",
		`(${topic || "untitled"}) (b${blockId})`,
		"",
		summary,
		"",
		`[Use decompress with blockId "b${blockId}" if you need the original content. search_context can query this block's summary.]`,
	].join("\n");
	return {
		role: "user",
		content: text,
		synthetic: true,
		timestamp: Date.now(),
	} as AgentMessage;
}

/** 给单条消息的首个文本块前置 ref 标签（先剥旧标签，保证幂等）。 */
function injectRefTag(m: AgentMessage, ref: string): AgentMessage {
	const role = (m as { role?: string }).role;
	const tag = `<dcp-message-id>${ref}</dcp-message-id>\n`;
	const strip = (s: string): string => s.replace(REF_TAG_RE, "");
	const tagFirstTextBlock = (content: Array<{ type?: string; text?: string }>) =>
		content.map((c, idx, arr) => {
			const firstTextIdx = arr.findIndex((x) => x?.type === "text");
			if (idx === firstTextIdx && c.type === "text") return { ...c, text: tag + strip(String(c.text ?? "")) };
			return c;
		});

	if (role === "user" || role === "developer") {
		const msg = m as { content?: string | Array<{ type?: string; text?: string }> };
		if (typeof msg.content === "string") {
			return { ...m, content: tag + strip(msg.content) } as AgentMessage;
		}
		if (Array.isArray(msg.content)) {
			return { ...m, content: tagFirstTextBlock(msg.content) } as AgentMessage;
		}
		return m;
	}
	if (role === "assistant" || role === "toolResult") {
		const msg = m as { content?: Array<{ type?: string; text?: string }> };
		if (!Array.isArray(msg.content)) return m;
		return { ...m, content: tagFirstTextBlock(msg.content) } as AgentMessage;
	}
	return m;
}

/**
 * 工具事务闭合：把 [start,end] 扩到 toolCall/toolResult 配对完整。
 * 区间断开配对（assistant 的 toolCall 落在区间、其 toolResult 在区间外，或反之）
 * 会造出非法请求序列（Anthropic 严格校验相邻配对），必须扩界。
 */
export function expandToTransactionBounds(
	messages: AgentMessage[],
	start: number,
	end: number,
): { start: number; end: number } {
	let s = start;
	let e = end;
	for (;;) {
		const callIds = new Set<string>();
		const resultIds = new Set<string>();
		for (let i = s; i <= e; i++) {
			const m = messages[i] as { role?: string };
			if (m?.role === "assistant") {
				const content = (m as { content?: unknown }).content;
				if (Array.isArray(content))
					for (const c of content as Array<{ type?: string; id?: string }>)
						if (c?.type === "toolCall" && c.id) callIds.add(c.id);
			} else if (m?.role === "toolResult") {
				const id = (m as { toolCallId?: string }).toolCallId;
				if (id) resultIds.add(id);
			}
		}
		let grew = false;
		// 有 call 无 result → 向下扩到 result 所在位置
		for (const id of callIds) {
			if (resultIds.has(id)) continue;
			for (let i = e + 1; i < messages.length; i++) {
				if ((messages[i] as { toolCallId?: string }).toolCallId === id) {
					e = i;
					grew = true;
					break;
				}
			}
		}
		// 有 result 无 call → 向上扩到 call 所在位置
		for (const id of resultIds) {
			if (callIds.has(id)) continue;
			for (let i = s - 1; i >= 0; i--) {
				const m = messages[i] as { role?: string; content?: unknown };
				if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
				if (
					(m.content as Array<{ type?: string; id?: string }>).some(
						(c) => c?.type === "toolCall" && c.id === id,
					)
				) {
					s = i;
					grew = true;
					break;
				}
			}
		}
		if (!grew) return { start: s, end: e };
	}
}

/** 判断是否为本适配层生成的摘要块消息（不占 ref 序号、不可再压缩）。 */
function isSummaryMessage(m: AgentMessage): boolean {
	return (
		(m as { role?: string }).role === "user" &&
		typeof (m as { content?: unknown }).content === "string" &&
		((m as { content?: string }).content ?? "").startsWith("[Compressed conversation section]")
	);
}

/**
 * 核心变换：原始视图 → 模型视图。
 * 每次调用都会刷新 state（refs、lastOriginal）——compress/decompress 依赖这里
 * 留下的坐标系。导出为纯函数供探针直接测试。
 */
export function transformContext(state: AcpSessionState, messages: AgentMessage[]): AgentMessage[] {
	state.refreshRefs(messages);
	state.lastOriginal = messages;

	// 活跃块定位（state.locateBlockAnchors：锚指纹三重校验）。找不到 → 跳过
	// 替换（宿主 compaction 折叠后原文消失，块退化为只能 decompress 取存档）。
	const located: Array<{ first: number; last: number; blockId: number; topic: string; summary: string }> = [];
	for (const block of state.activeBlocks()) {
		const anchors = state.locateBlockAnchors(block);
		if (anchors) located.push({ ...anchors, blockId: block.blockId, topic: block.topic, summary: block.summary });
	}

	// 从后往前替换，避免索引移位；srcIdx 同步跟踪每条输出消息的原始索引
	// （摘要消息为 -1），ref 注入按原始索引取号，压缩区间之后的消息 ref 不漂移。
	const out = [...messages];
	const srcIdx = messages.map((_, i) => i);
	for (const { first, last, blockId, topic, summary } of located.sort((a, b) => b.first - a.first)) {
		if (out.length >= last + 1) {
			out.splice(first, last - first + 1, summaryMessage(blockId, topic, summary));
			srcIdx.splice(first, last - first + 1, -1);
		}
	}

	// 占号但不注入标签——模型看不到它们的 ref，从源头减少误压缩入口
	// （区间级硬保护在 compress 里再做一层）
	const refs = state.refByIndex;
	const result: AgentMessage[] = [];
	for (let i = 0; i < out.length; i++) {
		const m = out[i];
		if (srcIdx[i] === -1) {
			result.push(m);
			continue;
		}
		const role = (m as { role?: string }).role;
		if (role === "toolResult" && ACP_TOOL_NAMES.has(String((m as { toolName?: string }).toolName ?? ""))) {
			result.push(m);
			continue;
		}
		const ref = refs[srcIdx[i]];
		result.push(ref ? injectRefTag(m, ref) : m);
	}

	// ---- nudge（仅本次请求，不进历史） ----
	// emitContext 的输出直通 convertToLlmFinal 请求链、不写回 journal，
	// 因此这里追加的提醒下一轮自然消失——与 opencode-acp 的 anchor 注入
	// 同语义。窗口未知（0）时整体禁用。百分比按 5% 档取整保持文本稳定
	// （前缀缓存友好）。
	const window_ = state.modelContextWindow;
	if (window_ > 0) {
		const estTokens = Math.ceil(
			result.map((m) => messageText(m)).join("").length / 4,
		);
		const usage = estTokens / window_;
		const { maxContextLimit, minContextLimit } = state.nudge;
		const minLimit = Math.min(minContextLimit, maxContextLimit);
		const maxLimit = Math.max(minContextLimit, maxContextLimit);

		if (usage >= minLimit) {
			const isHardLimit = usage >= maxLimit;
			const pctFloor = Math.min(100, Math.floor((usage * 100) / 5) * 5);
			const targetPct = Math.round(minLimit * 100);
			// 建议区间：最早的三条带 ref 的可压缩消息
			const suggest = refs.filter(Boolean).slice(0, 3);
			const first = suggest[0];
			const last = suggest[suggest.length - 1];

			const alertMsg = isHardLimit
				? `⚠️ Context limit reached (~${pctFloor}%). Compress consumed conversation ranges NOW with the compress tool.`
				: `💡 Context usage is at ~${pctFloor}%. This is an efficiency prompt to compress early and keep context lean (target below ~${targetPct}%).`;

			result.push({
				role: "user",
				content: [
					`[ACP context nudge] Context usage: ~${pctFloor}% (~${estTokens} / ${window_} tokens estimated).`,
					alertMsg,
					`Suggested target: ${first && last ? `the earliest tagged range (${first}..${last} area — check the actual boundaries in the conversation)` : "the oldest tagged messages"}.`,
					`Keep the recent working set (last few messages and any active task state) uncompressed. Use acp_status to review candidates.`,
				].join(" "),
				synthetic: true,
				timestamp: Date.now(),
			} as AgentMessage);
		}
	}
	return result;
}

/** 创建挂 context 事件的内联扩展工厂（传给 createAgentSession({ extensions })）。 */
export function createAcpContextExtension(state: AcpSessionState) {
	return (pi: {
		on: (
			event: "context",
			handler: (ev: { messages: AgentMessage[] }) => { messages: AgentMessage[] },
		) => void;
	}): void => {
		pi.on("context", (ev) => {
			try {
				return { messages: transformContext(state, ev.messages) };
			} catch (err) {
				// 视图变换失败绝不能炸请求：透传原始视图并落日志
				console.error(`[ACP] context transform failed, passing through:`, err);
				return { messages: ev.messages };
			}
		});
	};
}

/** 序列化消息为可读文本（块原文存档 / toFile 导出用）。 */
export function serializeForArchive(messages: AgentMessage[]): string {
	return messages.map((m) => messageText(m)).join("\n\n---\n\n");
}
