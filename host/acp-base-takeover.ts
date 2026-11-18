import { COMPACTION_RECOVERY_BAND, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, type ApiKey, type AssistantMessage, type Model, type UserMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
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
const SUMMARY_RETRY_DELAY_MS = 1_000;

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

function yieldToBase(reason: string): undefined {
	safeStderr(`[ACP] base compaction takeover yielded: ${reason}\n`);
	return undefined;
}

/** Produce the base compaction result from the ACP projection, or yield without side effects. */
export async function takeoverBaseCompaction(
	event: SessionBeforeCompactEvent,
	deps: AcpBaseTakeoverDeps,
): Promise<SessionBeforeCompactResult | undefined> {
	try {
		const { state } = deps;
		const firstKeptEntryId = event.preparation.firstKeptEntryId;
		if (!firstKeptEntryId) return yieldToBase("missing firstKeptEntryId");
		if (event.signal.aborted) return yieldToBase("event signal was already aborted");
		if (state.degraded) return yieldToBase(`ACP is degraded: ${state.degradeReason || "no reason recorded"}`);
		const branch = event.branchEntries;
		const cut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
		if (cut < 0) return yieldToBase(`firstKeptEntryId ${firstKeptEntryId} is not on the active branch`);
		const active = state.activeZoneMessages(branch);
		if (!active) return yieldToBase("active projection is unavailable or stale");
		const pseudoIds = active.filter(({ id }) => id.startsWith(ACP_VIEW_PSEUDO_PREFIX)).map(({ id }) => id);
		if (pseudoIds.length > 0) return yieldToBase(`active projection contains pseudo ids: ${pseudoIds.join(",")}`);

		const retainedIds = new Set(branch.slice(cut).map((entry) => entry.id));
		const sourceByBlock = new Map(state.lastBlocks.map((block) => [block.id, block.sourceId]));
		for (const block of state.zone) {
			for (const id of block.meta.compressedIds) {
				if (retainedIds.has(id) || retainedIds.has(sourceByBlock.get(id) ?? "")) {
					return yieldToBase(`compressed block ${block.id} overlaps the retained tail at ${id}`);
				}
			}
		}

		const branchPositions = new Map(branch.map((entry, index) => [entry.id, index]));
		const missing = active.find(({ id }) => !branchPositions.has(id));
		if (missing) return yieldToBase(`active message ${missing.id} is not on the active branch`);
		const prefix = active.filter(({ id }) => branchPositions.get(id)! < cut);
		const previousSummary = state.zoneRenderText();
		if (prefix.length === 0 && !previousSummary.trim()) return yieldToBase("active prefix and previous summary are both empty");
		const model = deps.getModel();
		if (!model) return yieldToBase("no active model");
		const now = deps.now ?? Date.now;
		const custom = event.customInstructions?.trim();
		const prompt = `${SUMMARY_INSTRUCTIONS}${previousSummary ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>` : ""}${custom ? `\n\nAdditional instructions:\n${custom}` : ""}`;
		const messages: AgentMessage[] = [
			...prefix.map(({ message }) => message),
			{ role: "user", content: prompt, timestamp: now() },
		];
		const timeoutMs = deps.timeoutMs ?? ACP_BASE_TAKEOVER_TIMEOUT_MS;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([event.signal, timeoutSignal]);
		let response!: AssistantMessage;
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				response = await (deps.complete ?? completeSimple)(model, { messages } as never, {
					apiKey: deps.getApiKey(model),
					disableReasoning: true,
					signal,
				});
			} catch (err) {
				if (attempt === 1 && !signal.aborted && AIError.retriable(AIError.classify(err, model.api))) {
					safeStderr(`[ACP] transient summary request failure; retrying once in ${SUMMARY_RETRY_DELAY_MS}ms`, err);
					await Bun.sleep(SUMMARY_RETRY_DELAY_MS);
					continue;
				}
				throw err;
			}
			if (response.stopReason !== "error" || attempt === 2) break;
			const error = new Error(response.errorMessage ?? "summary model returned an unknown error");
			if (signal.aborted || !AIError.retriable(AIError.classify(error, model.api))) break;
			safeStderr(`[ACP] transient summary response; retrying once in ${SUMMARY_RETRY_DELAY_MS}ms`, error);
			await Bun.sleep(SUMMARY_RETRY_DELAY_MS);
		}
		if (event.signal.aborted) return yieldToBase("event signal aborted during the summary request");
		if (timeoutSignal.aborted) return yieldToBase(`summary request timed out after ${timeoutMs}ms`);
		if (signal.aborted) return yieldToBase("summary request was aborted");
		if (response.stopReason === "error") return yieldToBase(`summary model returned error: ${response.errorMessage ?? "no error message"}`);
		const summary = responseText(response.content).trim();
		if (!summary) return yieldToBase("summary model returned empty text");

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
		if (messageTokens === undefined) return yieldToBase("projected message token counter is unavailable");
		const settings = resolveModelCompactionSettings(deps.settings, model);
		const recoveryBand = Math.floor(resolveThresholdTokens(model.contextWindow ?? 0, settings) * COMPACTION_RECOVERY_BAND);
		const candidateTokens = messageTokens + deps.getNonMessageTokens();
		if (candidateTokens > recoveryBand) {
			return yieldToBase(`candidate ${candidateTokens} tokens exceeds recovery band ${recoveryBand}`);
		}
		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore: state.projectedTokenEstimate(),
			},
		};
	} catch (err) {
		if (event.signal.aborted) return yieldToBase("event signal aborted during the summary request");
		safeStderr("[ACP] base compaction takeover failed; yielding to the caller's preparation", err);
		return undefined;
	}
}
