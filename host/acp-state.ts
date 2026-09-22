// ACP 压缩状态：块存储 + 消息引用（ref）映射。
//
// 设计要点（为什么这样映射）：
// - omp 的 LLM 消息（UserMessage/AssistantMessage/ToolResultMessage）没有稳定 id
//   字段（只有 timestamp / toolCallId），而 context 事件每次给的是"即将发给模型"
//   的深拷贝视图。ref（mNNNNN） therefore 绑定到「视图位置 + 内容指纹」：
//   前缀指纹匹配 → 保留编号（prompt cache 前缀稳定）；追加 → 续号；
//   前缀不匹配（宿主 compaction 折叠 / 分叉）→ 全量重编号，旧 ref 作废。
// - 压缩块保存「原文消息的深拷贝」，decompress 即把块标记 inactive——下一轮
//   context 变换自动还原原文。journal 永不被触碰。
// - 状态生命周期 = 会话生命周期（omp-desktop 会话本身 inMemory，不落盘）。
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** 视图消息 → 可读文本（指纹与原文序列化共用）。 */
export function messageText(m: AgentMessage): string {
	if (!m || typeof m !== "object") return "";
	const role = (m as { role?: string }).role ?? "";
	if (role === "user" || role === "developer") {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((c) => (c && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
				.join("");
		return "";
	}
	if (role === "assistant") {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) return "";
		return content
			.map((c) => {
				const b = c as { type?: string; text?: string };
				if (b.type === "text") return String(b.text ?? "");
				if (b.type === "toolCall") {
					const tc = c as { id?: string; tool?: string };
					return `[toolCall ${tc.id ?? "?"} ${tc.tool ?? "?"}]`;
				}
				return "";
			})
			.join("");
	}
	if (role === "toolResult") {
		const tr = m as { toolCallId?: string; toolName?: string; content?: unknown };
		const content = Array.isArray(tr.content)
			? tr.content
					.map((c) =>
						c && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "",
					)
					.join("")
			: "";
		return `[toolResult ${tr.toolCallId ?? "?"} ${tr.toolName ?? "?"}] ${content}`;
	}
	return "";
}

/** 位置指纹：role + 首段文本 + timestamp + 工具调用 id（assistant/result 唯一性强）。 */
export function messageFingerprint(m: AgentMessage): string {
	const role = (m as { role?: string }).role ?? "?";
	const ts = (m as { timestamp?: number }).timestamp ?? 0;
	let tail = "";
	if (role === "assistant") {
		const content = (m as { content?: unknown }).content;
		if (Array.isArray(content))
			tail = content
				.filter((c) => (c as { type?: string }).type === "toolCall")
				.map((c) => String((c as { id?: string }).id ?? ""))
				.join(",");
	} else if (role === "toolResult") {
		tail = String((m as { toolCallId?: string }).toolCallId ?? "");
	}
	const head = messageText(m).slice(0, 200);
	return `${role}|${ts}|${tail}|${head}`;
}

export interface AcpBlock {
	/** 块号（b<blockId>）。 */
	blockId: number;
	topic: string;
	summary: string;
	/** 压缩时的原文消息深拷贝（decompress 还原用）。 */
	originalMessages: AgentMessage[];
	/** 压缩时的视图区间 [firstIndex, lastIndex]（闭区间，指纹化前的索引）。 */
	firstIndex: number;
	lastIndex: number;
	/** false = 已被 decompress 或被嵌套压缩消费，视图不再替换。 */
	active: boolean;
	/** 被后续块消费时保留原文（深层 decompress 用）。 */
	createdAt: number;
}
/** ACP 自身的五个工具名——其调用/结果受硬保护，绝不可被压缩。 */
export const ACP_TOOL_NAMES = new Set(["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]);

/** nudge 配置（omp-desktop.json 的 acp 段；窗口未知时 nudge 整体禁用）。 */
export interface AcpNudgeConfig {
	/** 触发强提醒的用量上限（0-1，默认 0.55）。 */
	maxContextLimit: number;
	/** 压缩目标线（0-1，默认 0.45）——写进提醒文案，指导压到多少以下。 */
	minContextLimit: number;
}

export class AcpSessionState {
	/** 模型上下文窗口（token）；0 = 未知，nudge 禁用。host 建会话时填入。 */
	modelContextWindow = 0;
	/** nudge 阈值；host 从 omp-desktop.json 的 acp 段读入。 */
	nudge: AcpNudgeConfig = { maxContextLimit: 0.55, minContextLimit: 0.45 };
	blocks = new Map<number, AcpBlock>();
	private nextBlockId = 0;
	/** 每个视图位置对应的 ref（m00001 起，5 位补零，与 opencode-acp 一致）。视图变换读取。 */
	refByIndex: string[] = [];
	/** 最近一次 context 事件的原始视图（compress 定位/取原文的坐标系）。 */
	lastOriginal: AgentMessage[] = [];
	/** 与 refByIndex 对齐的指纹（前缀匹配校验）。 */
	private fpByIndex: string[] = [];

	allocBlockId(): number {
		return this.nextBlockId++;
	}

	refCount(): number {
		return this.refByIndex.length;
	}

	/**
	 * 用当前视图指纹刷新 ref 映射。
	 * 返回与视图等长的 ref 数组；前缀不匹配时全量重编号（旧 ref 作废——
	 * 上游宿主 compaction 折叠过历史，模型看到的已是新序列）。
	 */
	refreshRefs(messages: AgentMessage[]): string[] {
		const fps = messages.map(messageFingerprint);
		let stable = 0;
		const max = Math.min(fps.length, this.fpByIndex.length);
		while (stable < max && fps[stable] === this.fpByIndex[stable]) stable++;
		const refs: string[] = [];
		for (let i = 0; i < stable; i++) refs.push(this.refByIndex[i]);
		for (let i = stable; i < fps.length; i++) refs.push(`m${String(i + 1).padStart(5, "0")}`);
		this.refByIndex = refs;
		this.fpByIndex = fps;
		return refs;
	}

	/** ref（m00001 / b2）→ 当前视图区间。块引用解析为块压缩时的区间。 */
	resolveRef(ref: string): { firstIndex: number; lastIndex: number } | null {
		const m = /^m(\d{1,5})$/.exec(ref);
		if (m) {
			const idx = Number(m[1]) - 1;
			if (idx < 0 || idx >= this.refByIndex.length) return null;
			return { firstIndex: idx, lastIndex: idx };
		}
		const b = /^b(\d+)$/.exec(ref);
		if (b) {
			const block = this.blocks.get(Number(b[1]));
			if (!block) return null;
			return { firstIndex: block.firstIndex, lastIndex: block.lastIndex };
		}
		return null;
	}

	/** 视图位置 → ref 字符串（注入标签用）。 */
	refAt(index: number): string | undefined {
		return this.refByIndex[index];
	}

	activeBlocks(): AcpBlock[] {
		return [...this.blocks.values()].filter((b) => b.active).sort((a, b) => a.blockId - b.blockId);
	}

	/** 块锚指纹在当前原始视图中的定位（首+尾+长度三重校验）。 */
	locateBlockAnchors(block: AcpBlock): { first: number; last: number } | null {
		const fps = block.originalMessages.map(messageFingerprint);
		if (fps.length === 0 || this.lastOriginal.length < fps.length) return null;
		for (let i = 0; i + fps.length <= this.lastOriginal.length; i++) {
			if (
				messageFingerprint(this.lastOriginal[i]) === fps[0] &&
				messageFingerprint(this.lastOriginal[i + fps.length - 1]) === fps[fps.length - 1]
			) {
				return { first: i, last: i + fps.length - 1 };
			}
		}
		return null;
	}

	/**
	 * 边界 ref（mNNNNN / bN）→ 当前原始视图区间。
	 * 反向边界自动纠正（对齐 opencode-acp Bug 34 行为）。找不到返回 null。
	 */
	locateRange(startRef: string, endRef: string): { first: number; last: number } | null {
		const locate = (ref: string): number | null => {
			const m = /^m(\d{1,5})$/.exec(ref);
			if (m) {
				const idx = Number(m[1]) - 1;
				return idx >= 0 && idx < this.lastOriginal.length ? idx : null;
			}
			const b = /^b(\d+)$/.exec(ref);
			if (b) {
				const block = this.blocks.get(Number(b[1]));
				if (!block) return null;
				return this.locateBlockAnchors(block)?.first ?? null;
			}
			return null;
		};
		// b-ref 作为终点时定位到块尾而非块首
		const locateEnd = (ref: string): number | null => {
			const b = /^b(\d+)$/.exec(ref);
			if (b) {
				const block = this.blocks.get(Number(b[1]));
				if (block) return this.locateBlockAnchors(block)?.last ?? null;
			}
			return locate(ref);
		};
		const s = locate(startRef);
		const e = locateEnd(endRef);
		if (s === null || e === null) return null;
		return { first: Math.min(s, e), last: Math.max(s, e) };
	}
}

/** 多会话注册表（omp-desktop 是会话池）。 */
export class AcpStateRegistry {
	private bySession = new Map<string, AcpSessionState>();

	for(sessionId: string): AcpSessionState {
		let s = this.bySession.get(sessionId);
		if (!s) {
			s = new AcpSessionState();
			this.bySession.set(sessionId, s);
		}
		return s;
	}
}

/** 解析 acp.contextWindow：数字（2000000）或带后缀字符串（"200K"/"1M"/"2m"）。
 *  返回 0 表示未配置。 */
export function parseAcpContextWindow(v: unknown): number {
	if (typeof v === "number" && v > 0) return Math.floor(v);
	if (typeof v === "string") {
		const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(v);
		if (m) {
			const n = Number(m[1]);
			const mult = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
			return Math.floor(n * mult);
		}
	}
	return 0;
}
