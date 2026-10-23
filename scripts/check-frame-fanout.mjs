#!/usr/bin/env node
// Cross-channel fan-out gate (BUG-100: state frames that only one channel ever sees).
//
// Rules:
//  1. BLOCKING — a frame listed in scripts/frame-fanout.json "broadcast" must never be sent
//     through a bare `ws.send(...)`/`bus.send(...)` unless the enclosing function is one of the
//     canonical fan-out helpers below (they broadcast by contract) or the call carries an inline
//     `// fan-out: requester-only — <reason>` exemption. A requester-only send for shared state is
//     exactly how a model badge, computer toggle or settings copy goes stale on the other end.
//  2. WARNING — every broadcast frame should have a dual-channel assertion in
//     scripts/smoke-dual-channel.ts (`m.type === "<frame>"`); missing ones are printed so the next
//     pass can extend the smoke. Not blocking: coverage is added as frames get exercised.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "scripts/frame-fanout.json"), "utf8"));
const broadcast = new Set(registry.broadcast);

// Functions that fan a per-session/global frame out to every attached channel by contract.
const FANOUT_HELPERS = new Set([
  "pushSettings",
  "sendSessionState",
  "pushComputerMode",
  "pushPlanMode",
  "pushPlanState",
  "pushGoal",
  "pushContext",
  "pushSessionStats",
  "pushTodos",
  "sendQueued",
  "pushCommandOutput",
  "get_settings", // a read: replies to the asker only (see host/rpc/settings.ts)
]);

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Name of the innermost function/method containing `idx` ("" at file scope). */
function enclosingFn(src, idx) {
  const head = src.slice(0, idx);
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([a-zA-Z_$][\w$]*)\s*(?:=\s*(?:async\s*)?\(|\([^)]*\)\s*(?::[^={]*)?\{)/g;
  let name = "";
  for (const m of head.matchAll(re)) name = m[1];
  return name;
}

const problems = [];
const covered = new Set([...readFileSync(join(root, "scripts/smoke-dual-channel.ts"), "utf8").matchAll(/\.type === "([a-z_]+)"/g)].map((m) => m[1]));

for (const file of tsFiles(join(root, "host"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\b(?:ws|bus)\.send\(/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i++];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    const arg = src.slice(m.index, i);
    const frames = [...arg.matchAll(/type: "([a-z_]+)"/g)].map((x) => x[1]).filter((f) => broadcast.has(f));
    if (frames.length === 0) continue;
    const fn = enclosingFn(src, m.index);
    if (FANOUT_HELPERS.has(fn)) continue;
    const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
    if (line.includes("fan-out:") || line.includes("eachUiWs(")) continue;
    problems.push(`${file.slice(root.length + 1)}:${src.slice(0, m.index).split("\n").length} frame(s) ${frames.join(",")} sent to requester only (fn ${fn || "<top-level>"})`);
  }
}

for (const p of problems) console.error(`✗ ${p}`);

const uncovered = [...broadcast].filter((f) => !covered.has(f));
if (uncovered.length > 0) console.error(`⚠ broadcast frames without a dual-channel assertion (extend scripts/smoke-dual-channel.ts): ${uncovered.join(", ")}`);

if (problems.length > 0) {
  console.error(`\ncross-channel fan-out gate failed: ${problems.length} shared state frame(s) sent to requester only. Use sendSessionState / pushSettings / eachUiWs / entryBus, or add an inline "// fan-out: requester-only — <reason>".`);
  process.exit(1);
}
console.log(`✓ cross-channel fan-out gate passed: ${broadcast.size} shared frames with no requester-only send${uncovered.length > 0 ? `; ${uncovered.length} awaiting smoke coverage` : ""}`);
