// ACP T12 smoke: acpParamsFromConfig dual-mode tier thresholds (absolute/percent).
// Pure parameter coverage — no session or profile data is touched.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-acp-tiermode.ts
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { acpParamsFromConfig, ACP_DEFAULT_PARAMS } from "../host/acp-plan.ts";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");

// --- 1. absolute passthrough: stored values are token lines; missing = §11 default ---
const abs = acpParamsFromConfig({ l1: 150_000, l2: 250_000 });
assert.equal(abs.l1, 150_000);
assert.equal(abs.l2, 250_000);
assert.equal(abs.l3, ACP_DEFAULT_PARAMS.l3);
assert.equal(abs.target, ACP_DEFAULT_PARAMS.target);

// --- 2. percent conversion against the session model's context window ---
const pct = acpParamsFromConfig({ tierMode: "percent", l1: 25, l2: 50, l3: 75 }, 400_000);
assert.equal(pct.l1, 100_000);
assert.equal(pct.l2, 200_000);
assert.equal(pct.l3, 300_000);
assert.equal(acpParamsFromConfig({ tierMode: "percent", l1: 10 }, 12_345).l1, 1_235); // Math.round
// Unconfigured tiers keep the absolute defaults even in percent mode ("keep current
// behavior when unconfigured" decision).
assert.equal(pct.target, ACP_DEFAULT_PARAMS.target);

// --- 3. missing/invalid window: percent falls back to absolute semantics, warns once ---
let warned = 0;
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (() => {
	warned++;
	return true;
}) as typeof process.stderr.write;
assert.equal(acpParamsFromConfig({ tierMode: "percent", l1: 25 }, 0).l1, 25);
assert.equal(acpParamsFromConfig({ tierMode: "percent", l1: 30 }).l1, 30);
assert.equal(acpParamsFromConfig({ tierMode: "percent", l2: 40 }, -5).l2, 40);
assert.equal(warned, 1, "percent-without-window fallback warns exactly once");
assert.equal(acpParamsFromConfig({ tierMode: "percent", l3: 50 }, 0).l3, 50);
assert.equal(warned, 1, "module-level flag suppresses repeat warnings");
process.stderr.write = stderrWrite;

// --- 4. non-tier params pass through untouched; unknown tierMode = absolute ---
const rest = acpParamsFromConfig({ tierMode: "percent", l1: 50, target: 80_000, tailTurns: 4, tailUserMessages: 3 }, 200_000);
assert.equal(rest.l1, 100_000);
assert.equal(rest.target, 80_000);
assert.equal(rest.tailTurns, 4);
assert.equal(rest.tailUserMessages, 3);
assert.equal(acpParamsFromConfig({ tierMode: "bogus", l1: 7 }, 400_000).l1, 7);

console.log("smoke-acp-tiermode: ok");
