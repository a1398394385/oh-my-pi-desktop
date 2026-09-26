#!/usr/bin/env node
// host 模块边界门禁（借鉴 OBF check-core-boundaries 的最小版）：
// 1. 依赖方向表——host/ 内模块间 import 只许走 ALLOWED_EDGES 里声明的边，
//    其余（含反向依赖 host.ts）一律违规，防止拆分后悄悄长回一团；
// 2. 孤儿符号——import 的具名符号在目标模块必须有对应 export，
//    防止「搬走的函数残留 import」在运行时才炸。
// 解析用正则（本仓库 host 模块均为具名 export 的纯函数风格，够用）；
// limits/ 是 vendor 移植物不检查。
// 用法：node scripts/check-host-boundaries.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(root, "host");

// 允许的依赖边（A → B = A import B）。改动模块结构时同步此表并给出理由。
// host.ts 是薄入口（argv 分流）：宿主主体 main.ts 由其动态 import 装载，
// 动态 import 不在本表检查范围；下列 host 主体边均为 main.ts 的静态依赖。
const ALLOWED_EDGES = new Set([
  // ACP 集成：宿主主体 main.ts 挂载 acp 面板，acp-tools/context 依赖共享 acp-state（单向向下）
  "main.ts→acp-state.ts", "main.ts→acp-context.ts", "main.ts→acp-tools.ts",
  "acp-context.ts→acp-state.ts", "acp-tools.ts→acp-state.ts", "acp-tools.ts→acp-context.ts",
  // 历史会话检索工具（read_session_context）：只读当前 profile 的已落盘会话，
  // 依赖 bootstrap 的 SDK 句柄（listAllSessions / loadEntriesFromFile）
  "main.ts→session-context.ts", "session-context.ts→bootstrap.ts",
  // 右栏终端：main.ts 起 pty-bridge 子进程封装
  "main.ts→pty.ts",
  "main.ts→bootstrap.ts", "main.ts→state.ts", "main.ts→profile.ts", "main.ts→models.ts",
  "main.ts→assets.ts", "main.ts→stats.ts", "main.ts→translate.ts", "main.ts→limits",
  "profile.ts→state.ts", "profile.ts→bootstrap.ts", "profile.ts→models.ts",
  "models.ts→state.ts", "models.ts→bootstrap.ts",
  "assets.ts→state.ts", "assets.ts→bootstrap.ts",
  "stats.ts→bootstrap.ts",
  // 扩展中心（/extensions 搬移植）：extensions.ts 经 bootstrap 拿 SDK 句柄、读 H 状态，
  // main.ts 挂四个 RPC 分发（同 assets.ts 的接入形状）
  "main.ts→extensions.ts", "extensions.ts→bootstrap.ts", "extensions.ts→state.ts",
  "translate.ts→state.ts",
  "state.ts→bootstrap.ts",
  // /goal 命令桌面实现 + 目标续跑调度：main.ts 挂命令分发与事件钩子，
  // state.ts 的 PoolEntry 持有控制器实例（goal.ts 只依赖自身窄接口，单向向下）
  "main.ts→goal.ts", "state.ts→goal.ts",
]);

const files = readdirSync(hostDir).filter((f) => f.endsWith(".ts"));
const exportsOf = {}; // 文件 -> 具名 export 全集
const importsOf = {}; // 文件 -> [{ target, symbols, typeOnly }]

for (const f of files) {
  const src = readFileSync(join(hostDir, f), "utf8");
  const exported = new Set();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    exported.add(m[1]);
  }
  // top-level await 解构导出：export const { a, b: c } = await import("...")
  for (const m of src.matchAll(/export\s+const\s*\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s*:\s*/).pop()?.trim(); // a: b 形式导出名是 b
      if (name) exported.add(name);
    }
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exported.add(name);
    }
  }
  exportsOf[f] = exported;

  importsOf[f] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s*from\s*"\.\/([^"]+)"/g)) {
    const typeOnly = !!m[1];
    const symbols = [...m[2].split(",")].map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean);
    const target = m[3].replace(/\.ts$/, "");
    if (target.startsWith("limits")) continue; // vendor 移植物
    importsOf[f].push({ target: target.includes(".") ? target : `${target}.ts`, symbols, typeOnly });
  }
}

const problems = [];
for (const [file, imports] of Object.entries(importsOf)) {
  for (const imp of imports) {
    const edge = `${file}→${imp.target}`;
    if (!ALLOWED_EDGES.has(edge)) {
      problems.push(`非法依赖边: ${edge}（不在 ALLOWED_EDGES，改结构须同步表并附理由）`);
      continue;
    }
    // 孤儿符号：目标文件必须真的导出这些名字（type-only import 也查，防手误）
    const targetExports = exportsOf[imp.target];
    if (!targetExports) {
      problems.push(`依赖边指向不存在的模块: ${edge}`);
      continue;
    }
    for (const sym of imp.symbols) {
      if (!targetExports.has(sym)) problems.push(`孤儿符号: ${file} import { ${sym} } 但 ${imp.target} 未导出`);
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ host 模块边界违规（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ host 模块边界干净：${ALLOWED_EDGES.size} 条声明边全部成立，无孤儿符号`);
