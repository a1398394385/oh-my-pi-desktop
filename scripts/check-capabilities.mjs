#!/usr/bin/env node
// 能力清单一致性门禁（借鉴 OBF 产品控制平面的最小版）：
// host/capabilities.json 是 RPC 能力的单一事实源，本脚本把它与 host.ts
// switch 实际分发的 method 做双向 diff——任何一侧漂移都 exit 1。
// 用法：node scripts/check-capabilities.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "host/capabilities.json"), "utf8"));
const hostSrc = readFileSync(join(root, "host/host.ts"), "utf8");

// host.ts message 回调里的 case 字符串即实际分发的 method 全集。
// host.ts 内不允许出现第二个字符串 case switch；若未来出现，把非 RPC 的
// case 名加进下面 ignore 集（须附理由）。
const ignoreCases = new Set([]);
const dispatchCases = new Set(
  [...hostSrc.matchAll(/case "([a-z_]+[a-z0-9_]*)":/g)].map((m) => m[1]),
);

const listed = new Map(catalog.methods.map((m) => [m.id, m]));
const problems = [];

for (const m of catalog.methods) {
  if (!dispatchCases.has(m.id)) problems.push(`清单条目在 host.ts 无 case（过期能力）: ${m.id}`);
  if (!catalog.kinds.includes(m.kind)) problems.push(`kind 非法: ${m.id} -> ${m.kind}`);
  if (!catalog.risks.includes(m.risk)) problems.push(`risk 非法: ${m.id} -> ${m.risk}`);
}
for (const c of dispatchCases) {
  if (ignoreCases.has(c)) continue;
  if (!listed.has(c)) problems.push(`host.ts case 未登记进能力清单: ${c}`);
}
const dup = catalog.methods.length - listed.size;
if (dup > 0) problems.push(`清单存在 ${dup} 个重复 id`);

if (problems.length > 0) {
  console.error(`✗ 能力清单与 host.ts 漂移（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ 能力清单一致：${catalog.methods.length} 个 RPC method 全部登记且可解析`);
