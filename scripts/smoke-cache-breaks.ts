// Smoke: host/session-lifecycle.ts countCacheBreaks (the stats bar's
// cache-invalidation count behind the counter-clockwise arrow next to the
// cache-utilization percentage).
// Fixtures pin the heuristic: monotonic growth counts 0; a drop under half of
// the session peak counts one break; a gradual decay counts once (not per turn);
// tiny prompts are noise; recovery re-arms; a shrinking baseline (compaction)
// still lets a later break register.
import { countCacheBreaks } from "../host/session-lifecycle.ts";

type Msg = { type?: string; message?: { role?: string; usage?: { cacheRead?: number } } };

function reads(seq: number[]): Msg[] {
  return seq.map((cacheRead) => ({ type: "message", message: { role: "assistant", usage: { cacheRead } } }));
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
    { type: "message", message: { role: "user", usage: { cacheRead: 0 } } },
    { type: "other" },
    ...reads([0]),
  ], 1],
];

let failures = 0;
for (const [name, entries, expected] of cases) {
  const got = countCacheBreaks(entries);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: expected ${expected}, got ${got}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
