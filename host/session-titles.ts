// Continuous session-title refresh + per-branch title entries.
//
// Two independent switches live in omp-desktop.json's sessionTitles section:
//   refresh      — regenerate the title after every settled turn (deepseek-harness
//                  "regenerate per user message" behavior). The base only titles
//                  untitled sessions once, so this is desktop-only.
//   branchTitles — journal each title as a `branchTitle` custom entry on the
//                  active branch and mirror the branch's own title into the header
//                  on branch switch, so A/B forks keep distinct titles.
//
// Branch titles rewrite the header with source "user": the base refuses
// `setSessionName(auto)` once `titleSource` is "user", and repeated branch
// switches must keep landing. "Who really authored this title" therefore lives in
// the entry's own `source` field — header `titleSource` is only an unlock flag and
// no desktop gate may read it while branchTitles is on.
//
// The journal is the source of truth for display: entries are appended with
// appendCustomEntry (public, persists, advances the leaf like any other entry), so
// a title written on branch A is simply the last branchTitle on A's root→leaf path
// and never leaks into B.
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { buildReplanTitleContext } from "@oh-my-pi/pi-coding-agent/session/messages";

/** customType identifying per-branch titles in the session journal. */
export const BRANCH_TITLE_CUSTOM_TYPE = "branchTitle";

/** Persisted branchTitle payload; `source` is the real author, not the header's unlock value. */
export interface BranchTitleData {
	title: string;
	source: "auto" | "user";
}

// Structural slice of the base SessionManager / PoolEntry; importing the full
// types would add session-titles.ts→state.ts boundaries for a few fields.
type BranchTitleEntry = {
	id: string;
	parentId: string | null;
	type: string;
	customType?: string;
	data?: unknown;
};

type TreeStub = { entry: BranchTitleEntry; children: TreeStub[] };

type TitleEntry = {
	session: {
		messages: Parameters<typeof buildReplanTitleContext>[0];
		generateTitle: (text: string, extra: undefined, signal: AbortSignal) => Promise<string | null | undefined>;
		titleGenerationSignal: AbortSignal;
	};
	manager: {
		titleSource: string | undefined;
		getSessionName(): string | undefined;
		setSessionName(name: string, source: "auto" | "user"): Promise<void> | void;
		getBranch(): BranchTitleEntry[];
		getTree(): TreeStub[];
		getLeafId(): string | null;
		appendCustomEntry(customType: string, data?: unknown): string;
	};
};

/** Whether per-turn title refresh is enabled (sessionTitles.refresh, off by default). */
export function readSessionTitleRefresh(): boolean {
	return readDesktopSection("sessionTitles").refresh === true;
}

/** Write sessionTitles.refresh back (merge-write preserves the section's other fields). */
export function writeSessionTitleRefresh(enabled: boolean): void {
	writeDesktopSection("sessionTitles", { ...readDesktopSection("sessionTitles"), refresh: enabled });
}

/** Whether per-branch title entries and header mirroring are enabled (sessionTitles.branchTitles, off by default). */
export function readBranchTitles(): boolean {
	return readDesktopSection("sessionTitles").branchTitles === true;
}

/** Write sessionTitles.branchTitles back (merge-write preserves refresh). */
export function writeBranchTitles(enabled: boolean): void {
	writeDesktopSection("sessionTitles", { ...readDesktopSection("sessionTitles"), branchTitles: enabled });
}

function branchTitleOf(entry: BranchTitleEntry): BranchTitleData | null {
	if (entry.type !== "custom" || entry.customType !== BRANCH_TITLE_CUSTOM_TYPE) return null;
	const data = entry.data as { title?: unknown; source?: unknown } | undefined;
	if (typeof data?.title !== "string") return null;
	return { title: data.title, source: data.source === "user" ? "user" : "auto" };
}

/**
 * The active branch's own title: the last branchTitle entry on the root→leaf path.
 * Entries written on a sibling branch never appear here, so branch switching reads
 * the right title with no extra branch bookkeeping.
 */
export function readBranchTitle(manager: { getBranch(): BranchTitleEntry[] }): BranchTitleData | null {
	const branch = manager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const found = branchTitleOf(branch[i]!);
		if (found) return found;
	}
	return null;
}

/** Append one title to the active branch (advances the leaf; callers own header sync). */
export function appendBranchTitle(manager: TitleEntry["manager"], title: string, source: BranchTitleData["source"]): void {
	manager.appendCustomEntry(BRANCH_TITLE_CUSTOM_TYPE, { title, source } satisfies BranchTitleData);
}

/** Count children per parent across the whole entry forest (one flatten per call). */
function childCounts(roots: TreeStub[]): Map<string | null, number> {
	const counts = new Map<string | null, number>();
	const walk = (node: TreeStub): void => {
		counts.set(node.entry.parentId, (counts.get(node.entry.parentId) ?? 0) + 1);
		for (const child of node.children) walk(child);
	};
	for (const root of roots) walk(root);
	return counts;
}

/**
 * Whether the active branch owns a hand-written title, i.e. a user branchTitle
 * written after the nearest fork point. A user title inherited from an ancestor
 * branch must not freeze auto-generation on every descendant, so entries at or
 * before the fork do not count. Linear history (no fork) counts every entry.
 */
function hasOwnUserTitle(manager: TitleEntry["manager"]): boolean {
	const branch = manager.getBranch();
	let userIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branchTitleOf(branch[i]!)?.source === "user") {
			userIdx = i;
			break;
		}
	}
	if (userIdx < 0) return false;
	// First path node whose parent has siblings: everything before it is shared.
	const counts = childCounts(manager.getTree());
	let firstOwnIdx = -1;
	for (let i = 0; i < branch.length; i++) {
		if ((counts.get(branch[i]!.parentId) ?? 0) > 1) firstOwnIdx = i;
	}
	return userIdx >= firstOwnIdx;
}

// One in-flight generation per pool entry: a newer turn (or a branch switch)
// aborts the older call so its result cannot land on a branch the user left.
const inFlight = new WeakMap<object, AbortController>();

/**
 * Maybe regenerate the session title after a terminal agent_end. Fire-and-forget:
 * must never throw into the turn-end path. The base's own first-title generation
 * may still be in flight; both writes use the same header field, so last write
 * wins and nothing gets pinned — acceptable.
 */
export function maybeRefreshSessionTitle(entry: TitleEntry): void {
	try {
		if (!readSessionTitleRefresh()) return;
		const perBranch = readBranchTitles();
		// With branch titles off this keeps the original base gate; with it on the
		// header is tagged "user" by us, so that gate would silence every refresh.
		if (!perBranch && entry.manager.titleSource === "user") return;
		if (perBranch && hasOwnUserTitle(entry.manager)) return;
		const context = buildReplanTitleContext(entry.session.messages);
		if (!context) return;
		const leafId = entry.manager.getLeafId();
		inFlight.get(entry)?.abort();
		const controller = new AbortController();
		inFlight.set(entry, controller);
		void (async () => {
			try {
				const title = await entry.session.generateTitle(
					context,
					undefined,
					AbortSignal.any([entry.session.titleGenerationSignal, controller.signal]),
				);
				if (!title) return;
				// Branch moved while the model was thinking: the title belongs to the
				// branch the user left, and a late write would land on the wrong one.
				// Dropping is safe — that branch regenerates on its next settled turn.
				if (entry.manager.getLeafId() !== leafId) return;
				const last = perBranch ? readBranchTitle(entry.manager) : null;
				if (perBranch && title !== last?.title) appendBranchTitle(entry.manager, title, "auto");
				if (title !== entry.manager.getSessionName()) {
					await entry.manager.setSessionName(title, perBranch ? "user" : "auto");
				}
			} catch (err) {
				// Abort is the ordinary path for a superseded call, not a failure.
				if (!controller.signal.aborted) console.warn("[session-titles] title refresh failed:", err);
			} finally {
				if (inFlight.get(entry) === controller) inFlight.delete(entry);
			}
		})();
	} catch (err) {
		console.warn("[session-titles] title refresh gate failed:", err);
	}
}
