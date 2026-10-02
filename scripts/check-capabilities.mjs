#!/usr/bin/env node
// Capabilities manifest consistency gate (minimal version borrowed from the OBF product control plane):
// host/capabilities.json is the single source of truth for RPC capabilities; this script bidirectional-diffs it against
// the methods the host actually dispatches -- any drift on either side exits 1.
// Dispatch shape (since the third cut on 2026-09-28): main.ts dispatches via lookup tables, so the actual method set =
// the object-method keys of each domain handler table in host/rpc/*.ts (members indented two levels whose first param is ws/_ws).
// Usage: node scripts/check-capabilities.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "host/capabilities.json"), "utf8"));

const rpcDir = join(root, "host/rpc");
const rpcSources = readdirSync(rpcDir)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "types.ts")
  .map((f) => readFileSync(join(rpcDir, f), "utf8"))
  .join("\n");

// The keys of each domain handler table are the full set of actually dispatched methods: object-method shorthand (optionally async),
// first param ws/_ws, indented 2 spaces (top-level functions are not indented, so helpers are naturally excluded).
const dispatchCases = new Set(
  [...rpcSources.matchAll(/^ {2}(?:async )?([a-z_][a-z0-9_]*)\( ?(?:ws|_ws)[,)]/gm)].map((m) => m[1]),
);

const listed = new Map(catalog.methods.map((m) => [m.id, m]));
const problems = [];

for (const m of catalog.methods) {
  if (!dispatchCases.has(m.id)) problems.push(`清单条目在 host.ts 无 case（过期能力）: ${m.id}`);
  if (!catalog.kinds.includes(m.kind)) problems.push(`kind 非法: ${m.id} -> ${m.kind}`);
  if (!catalog.risks.includes(m.risk)) problems.push(`risk 非法: ${m.id} -> ${m.risk}`);
}
for (const c of dispatchCases) {
  if (!listed.has(c)) problems.push(`rpc handler 未登记进能力清单: ${c}`);
}
const dup = catalog.methods.length - listed.size;
if (dup > 0) problems.push(`清单存在 ${dup} 个重复 id`);

if (problems.length > 0) {
  console.error(`✗ 能力清单与 host.ts 漂移（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 能力清单一致：${catalog.methods.length} 个 RPC method 全部登记且可解析`);
