// ACP short refs + journal facts (spec §3 v10 + §6 v10): the bN registry and
// the view<->entry-id alignment moved out of acp-runtime (host file-size gate).
//
// bN rules (spec §3): every model-facing surface (manifest, index lines,
// candidate feedback, supersedes-chain notes) renders `bN`; the persisted
// layer (index/compressedIds/supersedes/JSONL) keeps entry ids and the mapping
// is never written to disk. Numbers are minted monotonically in JOURNAL order
// the first time an id is seen and never recycled (compressed/superseded ids
// keep theirs), so a restart replays the identical numbering by walking the
// same entries — holes from folded blocks are preserved by construction.
//
// The same walk collects the acp_status tool-pair facts (spec §6 v10): the
// pairs are never compression candidates, and the first acpSummary AFTER a
// pair in the journal (= the next successful compress) retires it from the
// projection entirely — storage untouched, derived purely from the journal so
// restarts land on the same sets with zero extra persistence.
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { messageFingerprint } from "./acp-fingerprint.ts";
import { splitBlocks } from "./acp-projection.ts";
import { ACP_SUMMARY_CUSTOM_TYPE } from "./acp-persist.ts";

/** Pseudo-id prefix for view messages absent from the journal (never a legal manifest id). */
export const ACP_VIEW_PSEUDO_PREFIX = "view:";

/** Fingerprint window for aligning a view message against the journal. */
const ACP_ALIGN_WINDOW = 64;

/**
 * Attach journal entry ids to a request view (the manifest's block-id
 * namespace). In-order greedy fingerprint match: view messages derive from
 * journal entries in order, with base-synthetic messages interleaved (they
 * consume no journal slot); the window only guards pathological drift.
 */
export function annotateView(view: readonly AgentMessage[], entries: readonly SessionEntry[]): Array<{ id: string; message: AgentMessage }> {
	const journal = entries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message");
	const fps = journal.map((e) => messageFingerprint(e.message));
	let ptr = 0;
	const ids = view.map((m) => {
		const fp = messageFingerprint(m);
		for (let k = ptr; k < fps.length && k - ptr < ACP_ALIGN_WINDOW; k++) {
			if (fps[k] === fp) {
				ptr = k + 1;
				return journal[k].id;
			}
		}
		return null;
	});
	return view.map((m, j) => ({ id: ids[j] ?? `${ACP_VIEW_PSEUDO_PREFIX}${j}`, message: m }));
}

/** Session-level bN registry + acp_status-pair facts, replayed from the journal (spec §3/§6 v10). */
export class AcpRefBook {
	#shortOf = new Map<string, string>(); // block id -> "bN"
	#idOf = new Map<string, string>(); // "bN" -> block id
	#next = 1;
	/** Entry ids the journal walk already numbered (prune rewrites keep ids, so ids are the stable key). */
	#walked = new Set<string>();
	/** Result-block ids of acp_status pairs no later successful compress has retired: candidate-excluded, still rendered. */
	readonly liveStatusResults = new Set<string>();
	/** Result-block ids of acp_status pairs a successful compress already retired: dropped from the projection (pair-wise). */
	readonly droppedStatusResults = new Set<string>();

	/**
	 * Walk the journal in order, numbering unseen block ids (message blocks by
	 * splitBlocks id derivation, acpSummary entries by their own id) and
	 * updating the acp_status-pair sets. Idempotent and incremental; the
	 * journal is append-only, so first-seen order == journal order and a
	 * restart replays identical numbers.
	 */
	sync(entries: readonly SessionEntry[]): void {
		for (const e of entries) {
			if (this.#walked.has(e.id)) continue;
			this.#walked.add(e.id);
			if (e.type === "message") {
				// Zero-counter pass: ids only (presence of thinking/text blocks
				// follows the same splitBlocks logic the projection uses).
				for (const b of splitBlocks([{ id: e.id, message: e.message }], () => 0)) this.assign(b.id);
				const m = e.message as { role?: string; toolName?: string };
				if (m.role === "toolResult" && m.toolName === "acp_status") this.liveStatusResults.add(e.id);
			} else if (e.type === "custom" && e.customType === ACP_SUMMARY_CUSTOM_TYPE) {
				this.assign(e.id);
				// A successful compress landed: every acp_status pair so far is
				// stale (its manifest is void) — retire it from the projection.
				for (const id of this.liveStatusResults) this.droppedStatusResults.add(id);
				this.liveStatusResults.clear();
			}
		}
	}

	/** Mint (or look up) the label for one id; summaries appended mid-turn take their number here (journal tail). */
	assign(id: string): string {
		let label = this.#shortOf.get(id);
		if (label === undefined) {
			label = `b${this.#next++}`;
			this.#shortOf.set(id, label);
			this.#idOf.set(label, id);
		}
		return label;
	}

	/** The bN label of a known id (undefined for pseudo/unknown ids). */
	shortRef(id: string): string | undefined {
		return this.#shortOf.get(id);
	}

	/** Model-facing label: bN when known, the raw id otherwise (pure renders' default stays identity). */
	label(id: string): string {
		return this.#shortOf.get(id) ?? id;
	}

	/** Tool-entry decode (spec §3): bN -> block id; anything else passes through for the §6 validation to judge. */
	resolve(ref: string): string {
		return this.#idOf.get(ref) ?? ref;
	}
}
