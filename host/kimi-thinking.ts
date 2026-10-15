// Kimi auto-thinking gate (the `kimi` section of omp-desktop.json, per-profile).
//
// Why: Kimi's official Messages API docs state that switching the effort level
// breaks prefix-cache hits. The `auto` thinking level re-classifies every turn,
// so each switch re-bills the whole prefix at full price. The desktop default
// is therefore OFF — Kimi sessions run a locked level (usage conclusions of
// 2026-10-11: pin the level, e.g. `defaultThinkingLevel: high`); enabling the
// switch restores the `auto` option. Same storage shape as browser-config /
// computer-mode (section merge-write through state.ts's H).
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";

/** Provider id whose requests carry the Kimi effort/cache semantics. */
export const KIMI_PROVIDER_ID = "kimi-code";
/** Locked level pinned on Kimi when auto is off — every Kimi line exposes `high`; the base clamps unknown models anyway. */
export const KIMI_LOCKED_LEVEL = "high";

/** Whether Kimi models are offered the `auto` thinking level (off by default). */
export function readKimiAutoThinking(): boolean {
	const section = readDesktopSection("kimi");
	// missing/corrupt values count as off; only an explicit true enables auto
	return section.autoThinking === true;
}

/** Write kimi.autoThinking back (merge-write preserves the file's other keys and the section's other fields). */
export function writeKimiAutoThinking(enabled: boolean): void {
	const section = readDesktopSection("kimi");
	writeDesktopSection("kimi", { ...section, autoThinking: enabled });
}

/**
 * Resolve the thinking level a Kimi session may actually receive: with the
 * switch off, `auto` is pinned to KIMI_LOCKED_LEVEL. Any other provider/level
 * passes through untouched, so the gate is a no-op unless all three conditions
 * hold (Kimi + auto + switch off).
 */
export function gateKimiAutoThinking(provider: string | undefined, level: string | undefined): string | undefined {
	if (level !== "auto") return level;
	if (provider !== KIMI_PROVIDER_ID) return level;
	if (readKimiAutoThinking()) return level;
	return KIMI_LOCKED_LEVEL;
}
