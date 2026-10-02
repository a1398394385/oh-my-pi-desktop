// ACP compression state: block storage + message reference (ref) mapping.
//
// Design points (why the mapping looks like this):
// - omp LLM messages (UserMessage/AssistantMessage/ToolResultMessage) carry no
//   stable id field (only timestamp / toolCallId), and each context event hands
//   over a deep-copied view of "what is about to be sent to the model". A ref
//   (mNNNNN) is therefore bound to "view position + content fingerprint":
//   prefix fingerprint match -> keep numbering (prompt cache prefix stays
//   stable); append -> continue numbering; prefix mismatch (host compaction
//   folded / forked) -> full renumbering, old refs invalidated.
// - A compression block stores a deep copy of the original messages;
//   decompress simply marks the block inactive — the next context transform
//   restores the original automatically. The journal is never touched.
// - State lifetime = session lifetime (omp-desktop sessions are inMemory and
//   never hit disk).
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** View message -> readable text (shared by fingerprinting and source serialization). */
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

/** Position fingerprint: role + head text + timestamp + tool call ids (strongly unique for assistant/result). */
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
	/** Block id (b<blockId>). */
	blockId: number;
	topic: string;
	summary: string;
	/** Deep copy of the original messages at compression time (for decompress restore). */
	originalMessages: AgentMessage[];
	/** View range [firstIndex, lastIndex] at compression time (inclusive, pre-fingerprinting indices). */
	firstIndex: number;
	lastIndex: number;
	/** false = consumed by decompress or by nested compression; the view no longer replaces it. */
	active: boolean;
	/** Original kept when consumed by a later block (for deep decompress). */
	createdAt: number;
}
/** ACP's own five tool names — their calls/results are hard-protected and must never be compressed. */
export const ACP_TOOL_NAMES = new Set(["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]);

/** nudge config (the acp section of omp-desktop.json; nudge fully disabled when the window is unknown). */
export interface AcpNudgeConfig {
	/** Usage ceiling that triggers the hard reminder (0-1, default 0.55). */
	maxContextLimit: number;
	/** Compression target line (0-1, default 0.45) — written into the reminder text as the level to compress below. */
	minContextLimit: number;
}

export class AcpSessionState {
	/** Model context window (tokens); 0 = unknown, nudge disabled. Filled in by the host when creating the session. */
	modelContextWindow = 0;
	/** nudge thresholds; the host reads them from the acp section of omp-desktop.json. */
	nudge: AcpNudgeConfig = { maxContextLimit: 0.55, minContextLimit: 0.45 };
	blocks = new Map<number, AcpBlock>();
	private nextBlockId = 0;
	/** Ref per view position (m00001 onward, 5-digit zero-padded, matching opencode-acp). Read by the view transform. */
	refByIndex: string[] = [];
	/** Original view of the most recent context event (the coordinate system for compress locating / source extraction). */
	lastOriginal: AgentMessage[] = [];
	/** Fingerprints aligned with refByIndex (prefix match verification). */
	private fpByIndex: string[] = [];

	allocBlockId(): number {
		return this.nextBlockId++;
	}

	refCount(): number {
		return this.refByIndex.length;
	}

	/**
	 * Refresh the ref mapping with the current view fingerprints.
	 * Returns a ref array as long as the view; on prefix mismatch everything
	 * is renumbered (old refs invalidated — upstream host compaction folded
	 * history, the model already sees a new sequence).
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

	/** ref (m00001 / b2) -> current view range. A block ref resolves to the block's range at compression time. */
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

	/** View position -> ref string (for tag injection). */
	refAt(index: number): string | undefined {
		return this.refByIndex[index];
	}

	activeBlocks(): AcpBlock[] {
		return [...this.blocks.values()].filter((b) => b.active).sort((a, b) => a.blockId - b.blockId);
	}

	/** Locate a block's anchor fingerprints in the current original view (first + last + length triple check). */
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
	 * Boundary refs (mNNNNN / bN) -> current original-view range.
	 * Reversed boundaries are auto-corrected (aligned with opencode-acp Bug 34
	 * behavior). Returns null when not found.
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
		// a b-ref as the end boundary locates the block tail, not the block head
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

/** Multi-session registry (omp-desktop is a session pool). */
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

/** Parse acp.contextWindow: a number (2000000) or a suffixed string ("200K"/"1M"/"2m").
 *  Returns 0 when unconfigured. */
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
