#!/usr/bin/env node
// 能力清单一致性门禁（借鉴 OBF 产品控制平面的最小版）：
// host/capabilities.json 是 RPC 能力的单一事实源，本脚本把它与宿主实际分发的
// method 做双向 diff——任何一侧漂移都 exit 1。
// 分发形态（2026-09-28 第三刀起）：main.ts 查表分发，实际 method 全集 =
// host/rpc/*.ts 各域 handler 表的对象方法键（首参 ws/_ws 的两级缩进成员）。
// 用法：node scripts/check-capabilities.mjs
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

// 域 handler 表的键即实际分发的 method 全集：对象方法简写（可选 async），
// 首参为 ws/_ws，缩进 2 空格（顶层函数不缩进，天然排除辅助函数）。
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
