import { COMPACTION_RECOVERY_BAND, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, type ApiKey, type Model, type UserMessage } from "@oh-my-pi/pi-ai";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { renderCompactionBlock } from "./acp-projection.ts";
import type { AcpSummaryData } from "./acp-persist.ts";
import type { AcpRuntimeState } from "./acp-runtime.ts";
import { ACP_VIEW_PSEUDO_PREFIX } from "./acp-refs.ts";
import { safeStderr } from "./stderr.ts";

export const ACP_BASE_TAKEOVER_TIMEOUT_MS = 25_000;

export interface AcpBaseTakeoverDeps {
	state: AcpRuntimeState;
	getModel(): Model | undefined;
	getApiKey(model: Model): ApiKey | undefined;
	settings: Parameters<typeof resolveModelCompactionSettings>[0];
	getNonMessageTokens(): number;
	complete?: typeof completeSimple;
	timeoutMs?: number;
	now?: () => number;
}

const SUMMARY_INSTRUCTIONS = `Update the conversation summary for future work. Preserve established findings, exact paths and decisions, current workspace state, verification results, and the concrete next action. Respond with the summary text only; do not call tools.`;

function responseText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

/** Produce the base compaction result from the ACP projection, or yield without side effects. */
export async function takeoverBaseCompaction(
	event: SessionBeforeCompactEvent,
	deps: AcpBaseTakeoverDeps,
): Promise<SessionBeforeCompactResult | undefined> {
	try {
		const { state } = deps;
		const firstKeptEntryId = event.preparation.firstKeptEntryId;
		if (!firstKeptEntryId || event.signal.aborted || state.degraded) return undefined;
		const branch = event.branchEntries;
		const cut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
		if (cut < 0) return undefined;
		const active = state.activeZoneMessages(branch);
		if (!active || active.some(({ id }) => id.startsWith(ACP_VIEW_PSEUDO_PREFIX))) return undefined;

		const retainedIds = new Set(branch.slice(cut).map((entry) => entry.id));
		const sourceByBlock = new Map(state.lastBlocks.map((block) => [block.id, block.sourceId]));
		for (const block of state.zone) {
			for (const id of block.meta.compressedIds) {
				if (retainedIds.has(id) || retainedIds.has(sourceByBlock.get(id) ?? "")) return undefined;
			}
		}

		const branchPositions = new Map(branch.map((entry, index) => [entry.id, index]));
		if (active.some(({ id }) => !branchPositions.has(id))) return undefined;
		const prefix = active.filter(({ id }) => branchPositions.get(id)! < cut);
		const previousSummary = state.zoneRenderText();
		if (prefix.length === 0 && !previousSummary.trim()) return undefined;
		const model = deps.getModel();
		if (!model) return undefined;
		const now = deps.now ?? Date.now;
		const custom = event.customInstructions?.trim();
		const prompt = `${SUMMARY_INSTRUCTIONS}${previousSummary ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>` : ""}${custom ? `\n\nAdditional instructions:\n${custom}` : ""}`;
		const messages: AgentMessage[] = [
			...prefix.map(({ message }) => message),
			{ role: "user", content: prompt, timestamp: now() },
		];
		const signal = AbortSignal.any([event.signal, AbortSignal.timeout(deps.timeoutMs ?? ACP_BASE_TAKEOVER_TIMEOUT_MS)]);
		const response = await (deps.complete ?? completeSimple)(model, { messages } as never, {
			apiKey: deps.getApiKey(model),
			disableReasoning: true,
			signal,
		});
		if (signal.aborted || response.stopReason === "error") return undefined;
		const summary = responseText(response.content).trim();
		if (!summary) return undefined;

		const createdAt = now();
		const candidate: AcpSummaryData = {
			id: "base-candidate",
			summary,
			index: [],
			meta: {
				createdAt,
				depth: 0,
				method: "base",
				keepIds: [],
				compressedIds: [],
				supersedes: [],
				tokensBefore: event.preparation.tokensBefore,
				tokensAfter: 0,
			},
		};
		const candidateMessage: UserMessage = {
			role: "user",
			content: renderCompactionBlock(candidate),
			synthetic: true,
			timestamp: createdAt,
			historyRewriteAt: createdAt,
		};
		const retained = branch.slice(cut).flatMap((entry) => entry.type === "message" ? [entry.message] : []);
		const messageTokens = state.countProjectedMessages([candidateMessage, ...retained]);
		if (messageTokens === undefined) return undefined;
		const settings = resolveModelCompactionSettings(deps.settings, model);
		const recoveryBand = Math.floor(resolveThresholdTokens(model.contextWindow ?? 0, settings) * COMPACTION_RECOVERY_BAND);
		if (messageTokens + deps.getNonMessageTokens() > recoveryBand) return undefined;
		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore: state.projectedTokenEstimate(),
			},
		};
	} catch (err) {
		if (!event.signal.aborted) safeStderr("[ACP] base compaction takeover failed; yielding to base", err);
		return undefined;
	}
}
