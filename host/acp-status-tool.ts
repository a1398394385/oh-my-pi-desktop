// context_status tool + the v10 model-facing status text (spec §6 v10, §7).
//
// v10 moves the round manifest from the ephemeral (push) into this tool
// (pull): the no-tier range injects NOTHING (stable prefix, compression
// timing fully the model's), and every active tier injects only a one-line
// status row pointing here. The tool returns the dashboard — tier, allowed
// compress method, zone totals, the standing instruction (tier text +
// pending-strong note), and the current round's manifest with short refs —
// and every call re-snapshots the round: the returned manifest is THE scope
// for the next compress_context (keep ids must come from the latest return;
// one successful compress consumes it). Large returns ride the base tool
// truncation pipeline exactly like recall_block (T5 precedent).
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-agent-core";
import type { AcpParams } from "./acp-plan.ts";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";

/** Round-status fields the renders read (AcpRoundStatus structurally satisfies this). */
export interface AcpRoundStatusFields {
	tier: "none" | "L1" | "L2" | "L3";
	method: "normal" | "strong";
	pendingStrong: boolean;
	zoneTokens: number;
	activeTokens: number;
	projectedTokens: number;
	manifestText: string;
}

/** Tier instruction lines (spec §5.1/§7; pull-mode wording, deterministic, no wall-clock state).
 * `forced` marks the request the host pinned to compress_context (tool_choice): the model cannot
 * call context_status there, so L3 must point at the manifest already in the request instead. */
const TIER_INSTRUCTIONS: Record<"L1" | "L2" | "L3", (p: AcpParams, forced: boolean) => string> = {
	L1: () =>
		"Active-zone context is above the activation line (L1): consider compressing completed work — call context_status for the round manifest, then compress_context with the short ids (bN) to keep and a summary covering every other listed block.",
	L2: (p) =>
		`Context pressure is high (L2): compress this round. Call context_status for the manifest; after compression, keep + the protected tail must stay under the target of ${p.target} tokens.`,
	L3: (_p, forced) =>
		forced
			? "Final notice (L3): this request is pinned to compress_context — compress immediately with a full summary of the listed blocks above you are not keeping."
			: "Final notice (L3): the next turn must complete a successful compression, or the host will force one. Call context_status now, then compress_context with a full summary of the listed blocks you are not keeping.",
};

/** Pending-strong annotation: uniform across every tier while the zone is over its line (spec §5.2/§7). */
const PENDING_STRONG_NOTE =
	"Pending strong: the compression zone is over its budget line — the next compression will be a strong one (the whole zone folds into a single summary block).";

/** The ephemeral's manifest pointer (§7 v10): the manifest itself lives in context_status, never here —
 * except on a forced request, where the synthetic context_status return already delivered it. */
const statusPointer = (forced: boolean) =>
	forced
		? "Compression manifest: the context_status return above lists this round's candidate blocks (short ids) — compress from it now."
		: "Compression manifest: call the context_status tool to list this round's candidate blocks (short ids).";
/** The one-line status row shared by the ephemeral and the tool return (tier + method + totals). `marker` separates the two surfaces' provenance. */
function statusRow(rs: AcpRoundStatusFields, marker: string): string {
	return `${marker} tier=${rs.tier} compress=${rs.method} zone=${rs.zoneTokens} tokens active=${rs.activeTokens} tokens projected=${rs.projectedTokens} tokens`;
}

/**
 * The ephemeral status message (spec §7 v10): one status row + the standing
 * instruction + the pending-strong note + the context_status pointer. NEVER the
 * manifest. Rendering is fully deterministic (no wall-clock state) so an
 * unchanged round state yields byte-identical text. The [acp-status] marker
 * belongs to the ephemeral only — it must never appear in journaled text.
 */
export function renderEphemeralMessage(rs: AcpRoundStatusFields, p: AcpParams, forced = false): UserMessage {
	const text = [
		statusRow(rs, "[acp-status]"),
		// Tier none + pending-strong (§5.2 row 6): the annotation IS the message.
		...(rs.tier === "none" ? [] : [TIER_INSTRUCTIONS[rs.tier](p, forced)]),
		...(rs.pendingStrong ? [PENDING_STRONG_NOTE] : []),
		statusPointer(forced),
	].join("\n");
	return { role: "user", content: text, synthetic: true, timestamp: 0 };
}

/**
 * The L1 milestone message (§7 v10.4): the L1 segment no longer injects on
 * every request — the standing line fires once per crossed sub-line instead.
 * Same 3-line deterministic shape as the standing ephemeral, with the
 * milestone marker appended to the status row (the `tier=L1 compress=…`
 * prefix stays intact for downstream matchers); never carries the manifest.
 */
export function renderMilestoneMessage(rs: AcpRoundStatusFields, milestone: number, p: AcpParams): UserMessage {
	const text = [
		`${statusRow(rs, "[acp-status]")} milestone=${milestone}/${p.milestoneSteps}`,
		TIER_INSTRUCTIONS.L1(p, false),
		statusPointer(false),
	].join("\n");
	return { role: "user", content: text, synthetic: true, timestamp: 0 };
}

/** Deterministic tool round id of the ultimatum's synthetic status pair (spec §6 v10.1): stable per session, never a journal id. */
export const ACP_SYNTHETIC_STATUS_CALL_ID = "acp-synthetic-status";

/**
 * The ultimatum's synthetic status pair (spec §6 v10.1): a FRESH assistant
 * tool_use (never an insert into an existing assistant — thinking-signature
 * and prefix-cache risk, spec §3 projection discipline) answered by its user
 * tool_result carrying the full [acp-report] dashboard. The request the force
 * pins ([forced,"none"] has one shot and cannot call context_status) already
 * holds the round manifest, so the forced keep-pick is an informed one. Never
 * journaled and never a compression candidate: rebuilt every request the
 * injection condition holds, byte-identical while the round state is unchanged.
 * The identity metadata is inert for wire conversion (no thinking blocks, no
 * signatures; stopReason toolUse keeps the call out of the abandoned-turn
 * placeholder pairing).
 */
export function renderSyntheticStatusPair(rs: AcpRoundStatusFields, p: AcpParams, forced = false): [AssistantMessage, ToolResultMessage] {
	const use: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: ACP_SYNTHETIC_STATUS_CALL_ID, name: "context_status", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "acp-synthetic-status",
		stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		timestamp: 0,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: ACP_SYNTHETIC_STATUS_CALL_ID,
		toolName: "context_status",
		content: [{ type: "text", text: renderStatusText(rs, p, forced) }],
		isError: false,
		timestamp: 0,
	};
	return [use, result];
}

/**
 * The context_status tool return (spec §6 v10): the dashboard + the current round
 * manifest with short refs, largest first, exemption trailer included. The
 * [acp-report] marker keeps the journaled tool result distinguishable from
 * the never-journaled [acp-status] ephemeral.
 */
export function renderStatusText(rs: AcpRoundStatusFields, p: AcpParams, forced = false): string {
	return [
		statusRow(rs, "[acp-report]"),
		...(rs.tier === "none" ? [] : [TIER_INSTRUCTIONS[rs.tier](p, forced)]),
		...(rs.pendingStrong ? [PENDING_STRONG_NOTE] : []),
		forced
			? "Current compression manifest (largest first; bN | tokens | intent). compress_context folds exactly the UNKEPT blocks of this list — keep ids must come from it, and one successful compress consumes it. Compress from this list now:"
			: "Current compression manifest (largest first; bN | tokens | intent). compress_context folds exactly the UNKEPT blocks of this list — keep ids must come from it, and one successful compress consumes it; call context_status again for the next round:",
		rs.manifestText,
	].join("\n");
}

/** Structural dependency: any runtime exposing status() (AcpRuntimeState; no import cycle). */
interface StatusHost {
	status(): { ok: true; text: string } | { ok: false; error: string };
}

const ACP_STATUS_DESCRIPTION = `Check the ACP context dashboard and fetch the current compression manifest (context management).

Returns the prompt tier (L1/L2/L3), the compression method allowed this round (normal/strong), active-zone and projected token totals, the standing instruction, and the current round's manifest: every compressible block as a bN short id with its token size and intent, largest first (blocks cut by the manifest budget are exempt this round and re-listed next round).

Every call returns the latest snapshot and refreshes the round: the manifest it returns is THE compression scope — compress_context keep ids must come from the most recent context_status return, and a successful compress consumes it. Call any time; a good habit is to check after finishing a stage of work and compress what has settled.`;

/** context_status ToolDefinition (registered next to compress_context, spec §6 v10). */
export function createAcpStatusTool(state: StatusHost) {
	return {
		name: "context_status",
		label: "Context Status",
		description: ACP_STATUS_DESCRIPTION,
		parameters: type({}),
		loadMode: "essential" as const,
		approval: "write" as const,
		execute: async (
			_id: string,
			_params: Record<string, never>,
			_signal: undefined,
			_onUpdate: unknown,
			ctx?: { allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }> },
		) => {
			const out = state.status();
			if (!out.ok) return { content: [{ type: "text", text: out.error }], isError: true };
			// Same base truncation pipeline as recall_block (spec §6): cap the
			// inline text, spill the full version to an artifact the model reads
			// back in segments — the tool itself never truncates.
			let text = out.text;
			const allocate = ctx?.allocateOutputArtifact;
			if (typeof allocate === "function") {
				text = await enforceInlineByteCap(text, {
					saveArtifact: async (full) => {
						const { id, path } = (await allocate("context_status")) ?? {};
						if (!id || !path) return undefined;
						await Bun.write(path, full);
						return id;
					},
				});
			}
			return { content: [{ type: "text", text }] };
		},
	};
}
