// Smoke: host/session-lifecycle.ts countCacheBreaks (the stats bar's
// cache-invalidation count behind the counter-clockwise arrow next to the
// cache-utilization percentage).
// Fixtures pin the heuristic: monotonic growth counts 0; a drop under half of
// the session peak counts one break; a gradual decay counts once (not per turn);
// tiny prompts are noise; recovery re-arms; a shrinking baseline still lets a
// later break register; a context compaction (base entry or ACP block) drops
// the prefix on purpose, so its drop is neither a break nor double-counted.
import { countCacheBreaks } from "../host/session-lifecycle.ts";
import { countCompactions } from "../host/session-snapshot.ts";

type Msg = { type?: string; customType?: string; message?: { role?: string; usage?: { cacheRead?: number; totalTokens?: number } } };

/** Base compaction entry (/compact, /handoff, plan approval, auto-compaction). */
function compacted(): Msg {
  return { type: "compaction" };
}

/** ACP compaction block (desktop's own compaction chain, spec §9). */
function acpBlock(): Msg {
  return { type: "custom", customType: "acpSummary" };
}

function reads(seq: number[]): Msg[] {
  return seq.map((cacheRead) => ({ type: "message", message: { role: "assistant", usage: { cacheRead, totalTokens: cacheRead + 8 } } }));
}

/** An assistant entry the user aborted before it billed anything: real shape, zero totalTokens. */
function aborted(cacheRead = 0): Msg {
  return { type: "message", message: { role: "assistant", usage: { cacheRead, totalTokens: 0 } } };
}

const cases: Array<[string, Msg[], number]> = [
  ["monotonic growth", reads([1000, 2000, 3000, 50000]), 0],
  ["single full invalidation", reads([20000, 45000, 0, 1000, 30000]), 1],
  ["tiny prompt is noise", reads([64, 0]), 0],
  ["gradual decay counts once", reads([20000, 2000, 9000, 9500]), 1],
  ["recovery re-arms", reads([20000, 0, 20000, 0]), 2],
  ["half-drop counts (glm real data)", reads([47424, 23616, 143552, 0, 165760]), 2],
  ["kimi near-full drop amid noise", reads([67072, 5632, 69632, 70656, 89088, 69632, 89856, 70656]), 1],
  ["non-assistant entries ignored", [
    ...reads([20000]),
    { type: "message", message: { role: "user", usage: { cacheRead: 0, totalTokens: 0 } } },
    { type: "other" },
    ...reads([0]),
  ], 1],
  // Session 01a12f18: a user-aborted turn (usage all zero, stopReason "aborted")
  // sits between two real turns and must not register a break.
  ["aborted turn is not a break", [...reads([119808, 156928]), aborted(), ...reads([157440])], 0],
  ["aborted turns between two real breaks", [...reads([156928]), aborted(), ...reads([0]), aborted(), ...reads([156928])], 1],
  ["aborted turn cannot re-arm", [...reads([20000, 0]), aborted(), ...reads([20000])], 1],
  // A compaction rewrites the prefix on purpose: the drop it causes is the
  // compaction's cost, reported by its own counter, never a cache invalidation.
  ["base compaction drop is not a break", [...reads([20000, 45000]), compacted(), ...reads([3000, 6000])], 0],
  ["ACP block drop is not a break", [...reads([20000]), acpBlock(), ...reads([2500, 5000, 9000])], 0],
  ["aborted turn after compaction keeps the re-baseline pending", [...reads([20000]), compacted(), aborted(), ...reads([100])], 0],
  ["break after a compaction still registers", [...reads([20000]), compacted(), ...reads([3000, 8000, 0, 9000])], 1],
];

const compactionCases: Array<[string, Msg[], number]> = [
  ["no compaction", reads([20000]), 0],
  ["base + ACP blocks all counted", [compacted(), ...reads([3000]), acpBlock(), ...reads([6000]), compacted()], 3],
  ["other custom entries are not compressions", [{ type: "custom", customType: "goal-continuation" }, ...reads([1])], 0],
];

let failures = 0;
for (const [name, entries, expected] of cases) {
  const got = countCacheBreaks(entries);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: expected ${expected}, got ${got}`);
}

for (const [name, entries, expected] of compactionCases) {
  const got = countCompactions(entries);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} compressions / ${name}: expected ${expected}, got ${got}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
