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
  "assets.ts→state.ts", "assets.ts→bootstrap.ts", "assets.ts→profile.ts",
  "stats.ts→bootstrap.ts",
  // 扩展中心（/extensions 搬移植）：extensions.ts 经 bootstrap 拿 SDK 句柄、读 H 状态，
  // main.ts 挂四个 RPC 分发（同 assets.ts 的接入形状）
  "main.ts→extensions.ts", "extensions.ts→bootstrap.ts", "extensions.ts→state.ts",
  "translate.ts→state.ts",
  "state.ts→bootstrap.ts",
  // /goal 命令桌面实现 + 目标续跑调度：main.ts 挂命令分发与事件钩子，
  // state.ts 的 PoolEntry 持有控制器实例（goal.ts 只依赖自身窄接口，单向向下）
  "main.ts→goal.ts", "state.ts→goal.ts",
  // 剥离 ACP 注入标签：translate.ts 消费 acp-context.ts 的 REF_TAG_RE 正则
  "translate.ts→acp-context.ts",
  // 共享 MCP 连接池：main.ts 驱动生命周期与 RPC，依赖 bootstrap 的 connectToServer 与 state
  "main.ts→mcp-pool.ts", "mcp-pool.ts→bootstrap.ts", "mcp-pool.ts→state.ts",
  // 计划模式域：main.ts 挂 /plan 分发与 plan_mode RPC；审批/输出桥与事件戳在 state
  "main.ts→plan.ts", "plan.ts→bootstrap.ts", "plan.ts→state.ts",
  // 会话生命周期域：main.ts 挂 create/load 分发；生命周期依赖 plan（恢复计划模式）、
  // queue（排队竞态兜底）、profile（实验开关）、assets（插件/钩子开关）
  "main.ts→session-lifecycle.ts",
  "session-lifecycle.ts→state.ts", "session-lifecycle.ts→bootstrap.ts",
  "session-lifecycle.ts→goal.ts", "session-lifecycle.ts→acp-state.ts",
  "session-lifecycle.ts→acp-context.ts", "session-lifecycle.ts→acp-tools.ts",
  "session-lifecycle.ts→session-context.ts", "session-lifecycle.ts→translate.ts",
  "session-lifecycle.ts→profile.ts", "session-lifecycle.ts→assets.ts",
  "session-lifecycle.ts→queue.ts", "session-lifecycle.ts→plan.ts",
  // 缓存保活（实验开关条件注入的内联扩展域，同 acp-context 先例；
  // 三文件平铺 keepalive/keepalive-config/keepalive-lib）
  "session-lifecycle.ts→keepalive.ts",
  "session-lifecycle.ts→keepalive-config.ts",
  "keepalive.ts→keepalive-config.ts", "keepalive.ts→keepalive-lib.ts",
  // 配置真源=omp-desktop.json keepalive 段（随 profile 独立），读写经 state.ts 的 H
  "keepalive-config.ts→state.ts",
  // 排队消息域：followUp/steering 视图、park 暂存与立即发送/放回/删除
  "main.ts→queue.ts", "queue.ts→bootstrap.ts", "queue.ts→state.ts",
  // 实验性功能开关（acp/sessionContext 段）与 profile 同住 omp-desktop.json
  "profile.ts→acp-state.ts",
  // 帧组装层：models/settings 帧被多个 rpc 域与 main 的 ready 帧共用
  // （独立成层的原因：settingsFrame 组合 models 快照与 profile/assets 开关，下沉任一侧成环）
  "main.ts→frames.ts",
  "frames.ts→state.ts", "frames.ts→models.ts", "frames.ts→profile.ts", "frames.ts→assets.ts",
  "frames.ts→keepalive-config.ts", // settings 帧携带 state.json 探测参数（实验性功能页配置化）
  // RPC 处理器九域（第三刀：message 巨型 switch 查表化）：main 只留分发壳
  "main.ts→rpc/index.ts",
  "rpc/index.ts→rpc/types.ts",
  "rpc/index.ts→rpc/session.ts", "rpc/index.ts→rpc/prompt.ts", "rpc/index.ts→rpc/files.ts",
  "rpc/index.ts→rpc/models.ts", "rpc/index.ts→rpc/settings.ts", "rpc/index.ts→rpc/login.ts",
  "rpc/index.ts→rpc/assets.ts", "rpc/index.ts→rpc/terminal.ts", "rpc/index.ts→rpc/limits.ts",
  "rpc/session.ts→rpc/types.ts",
  "rpc/session.ts→bootstrap.ts", "rpc/session.ts→state.ts", "rpc/session.ts→profile.ts",
  "rpc/session.ts→translate.ts", "rpc/session.ts→session-lifecycle.ts",
  "rpc/prompt.ts→rpc/types.ts", "rpc/prompt.ts→rpc/session.ts",
  "rpc/prompt.ts→bootstrap.ts", "rpc/prompt.ts→state.ts", "rpc/prompt.ts→translate.ts",
  "rpc/prompt.ts→session-lifecycle.ts", "rpc/prompt.ts→plan.ts", "rpc/prompt.ts→queue.ts",
  "rpc/files.ts→rpc/types.ts", "rpc/files.ts→state.ts", "rpc/files.ts→session-lifecycle.ts",
  "rpc/models.ts→rpc/types.ts", "rpc/models.ts→bootstrap.ts", "rpc/models.ts→state.ts",
  "rpc/models.ts→models.ts", "rpc/models.ts→frames.ts", "rpc/models.ts→limits",
  "rpc/models.ts→stats.ts",
  "rpc/settings.ts→rpc/types.ts", "rpc/settings.ts→rpc/session.ts",
  "rpc/settings.ts→state.ts", "rpc/settings.ts→models.ts", "rpc/settings.ts→frames.ts",
  "rpc/settings.ts→profile.ts", "rpc/settings.ts→assets.ts", "rpc/settings.ts→plan.ts",
  "rpc/settings.ts→keepalive-config.ts", // set_keepalive_config 合并写 state.json
  "rpc/login.ts→rpc/types.ts", "rpc/login.ts→bootstrap.ts", "rpc/login.ts→state.ts",
  "rpc/login.ts→models.ts", "rpc/login.ts→frames.ts",
  "rpc/assets.ts→rpc/types.ts", "rpc/assets.ts→bootstrap.ts", "rpc/assets.ts→state.ts",
  "rpc/assets.ts→assets.ts", "rpc/assets.ts→profile.ts", "rpc/assets.ts→extensions.ts",
  "rpc/assets.ts→models.ts", "rpc/assets.ts→frames.ts",
  "rpc/terminal.ts→rpc/types.ts", "rpc/terminal.ts→pty.ts",
  "rpc/limits.ts→rpc/types.ts", "rpc/limits.ts→bootstrap.ts", "rpc/limits.ts→state.ts",
  "rpc/limits.ts→limits",
]);

// 扫描 host/ 一层 + host/rpc/ 子目录（键带路径前缀，如 rpc/session.ts）
const files = [
  ...readdirSync(hostDir).filter((f) => f.endsWith(".ts")),
  ...readdirSync(join(hostDir, "rpc")).filter((f) => f.endsWith(".ts")).map((f) => `rpc/${f}`),
];
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
  // 只查相对导入（./ ../）；外部包（@oh-my-pi/*、node:*）不进边界表
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s*from\s*"(\.\.?\/)([^"]+)"/g)) {
    const typeOnly = !!m[1];
    const symbols = [...m[2].split(",")].map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean);
    const prefix = m[3];
    let target = m[4].replace(/\.ts$/, "");
    if (target.startsWith("limits")) continue; // vendor 移植物
    // ../x = 回 host 根；./x = 相对当前文件所在目录
    const base = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    if (prefix === "../") target = `${target}.ts`;
    else target = `${base}${target}${target.includes(".") ? "" : ".ts"}`;
    importsOf[f].push({ target, symbols, typeOnly });
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
