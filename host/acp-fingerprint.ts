// Position fingerprint for view<->journal alignment (kept verbatim from the
// retired nudge prototype's acp-state.ts — production-verified logic, never
// reworked). omp LLM messages carry no stable id, so a message is identified
// by role + head text + timestamp + tool call ids. Pure leaf: imports only types.
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
