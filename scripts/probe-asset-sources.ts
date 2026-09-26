// 探针：资产列表（技能 / MCP）是否遵循扩展页的来源开关。
// 回归防线：host/assets.ts 曾自行硬编码枚举 ~/.claude/skills 等外部目录、且不查来源状态，
// 于是「扩展页关掉某来源后，技能页仍列出该来源的技能」。
// 用法：bun scripts/probe-asset-sources.ts
// 强制 omp-desktop-test profile；结束时把改过的 settings 键复原。
// OMP_PROFILE 必须在 host/bootstrap.ts 求值前写入环境变量，故用动态 import。
process.env.OMP_PROFILE = "omp-desktop-test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE = "omp-desktop-test";
const { H } = await import("../host/state.ts");
const { refreshAvailableProfiles, applyProfile } = await import("../host/profile.ts");
const { loadAllSkillsScoped, loadAllMcpScoped } = await import("../host/assets.ts");
const { buildExtensionsPayload } = await import("../host/extensions.ts");

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

H.currentProfile = PROFILE;
await refreshAvailableProfiles();
await applyProfile(PROFILE);
assert(H.agentDir.includes(PROFILE), `profile 隔离生效（agentDir=${H.agentDir}）`);

// ~/.claude/plugins 是本机外部用户级来源之一（技能 provider=claude-plugins，MCP 同源）
const hasClaudePlugins = fs.existsSync(path.join(os.homedir(), ".claude", "plugins"));

// ---------- settings 快照（退出前复原） ----------
const KEYS = ["disabledProviders", "enabledProviders", "skills.enableClaudeUser", "skills.enableCodexUser"] as const;
const snapshot = new Map<string, unknown>(KEYS.map((k) => [k, H.settings.get(k)]));
async function restore() {
  for (const [k, v] of snapshot) H.settings.set(k, v ?? (k.startsWith("skills.") ? false : []));
  await H.settings.flush();
}

// 写入来源状态并重新装配底座 registry（disabledProviders 只经 initializeWithSettings 生效）
async function applySources(disabled: string[], enabled: string[], claudeToggle: boolean) {
  H.settings.set("disabledProviders", disabled);
  H.settings.set("enabledProviders", enabled);
  H.settings.set("skills.enableClaudeUser", claudeToggle);
  H.settings.set("skills.enableCodexUser", claudeToggle);
  await H.settings.flush();
  await applyProfile(PROFILE);
}

const skillProviders = async () => {
  const res = await loadAllSkillsScoped();
  const counts = new Map<string, number>();
  for (const s of res.profile) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  for (const p of res.projects) for (const s of p.skills) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  return counts;
};
const mcpProviders = async () => {
  const res = await loadAllMcpScoped();
  const counts = new Map<string, number>();
  for (const s of res.servers) counts.set(s.source.provider, (counts.get(s.source.provider) ?? 0) + 1);
  return counts;
};
const fmt = (m: Map<string, number>) => [...m].map(([p, n]) => `${p}=${n}`).join(" ") || "(空)";

// 本机没有该来源的任何资产时，只验证「关闭后不出现」，正向断言打印跳过
function assertAbsent(map: Map<string, number>, provider: string, what: string, off: Set<string>) {
  if (!off.has(provider)) return;
  assert((map.get(provider) ?? 0) === 0, `已关闭来源不出现在${what}列表：${provider}（本机计数 ${map.get(provider) ?? 0}）`);
}

try {
  // 用例 1：外部来源全关（技能级兼容开关同时打开）→ 任何已关来源的条目都不得出现
  const OFF = ["claude", "claude-plugins", "codex", "opencode", "cursor", "gemini"];
  await applySources(OFF, [], true);
  const offSkills = await skillProviders();
  const offMcp = await mcpProviders();
  console.log(`  关来源后技能 providers: ${fmt(offSkills)}`);
  console.log(`  关来源后 MCP providers: ${fmt(offMcp)}`);
  const off = new Set(OFF);
  for (const p of OFF) {
    assertAbsent(offSkills, p, "技能", off);
    assertAbsent(offMcp, p, "MCP", off);
  }
  const agentsWithOff = offSkills.get("agents") ?? 0;
  // 关掉的来源必须仍留在扩展页（行还在、开关可点回）——否则无法重新开启
  const extPayload = await buildExtensionsPayload("profile");
  const claudeRow = extPayload.providers.find((p) => p.id === "claude");
  assert(claudeRow !== undefined && claudeRow.enabled === false, "关闭的来源仍出现在扩展页供应商清单（enabled=false，可重新开启）");

  // 用例 2：来源全开但未 opt-in 外部工具 ~/ 配置 → 外部用户级来源仍不出现；非外部来源不受影响
  await applySources([], [], true);
  const onSkills = await skillProviders();
  const onMcp = await mcpProviders();
  console.log(`  开来源未 opt-in 技能 providers: ${fmt(onSkills)}`);
  console.log(`  开来源未 opt-in MCP providers: ${fmt(onMcp)}`);
  assert((onSkills.get("agents") ?? 0) === agentsWithOff, `非外部来源（agents）不受来源开关影响（${agentsWithOff}）`);
  assert((onSkills.get("claude") ?? 0) > 0, `来源开启时 ~/.claude/skills 技能在列表（claude=${onSkills.get("claude") ?? 0}）`);
  assert((onSkills.get("claude-plugins") ?? 0) === 0, "未 opt-in 时外部用户级来源 ~/.claude/plugins 不出现（技能）");
  assert((onMcp.get("claude-plugins") ?? 0) === 0, "未 opt-in 时外部用户级来源 ~/.claude/plugins 不出现（MCP）");

  // 用例 3：opt-in 外部工具 ~/ 配置 → 该来源资产回到列表
  await applySources([], ["claude"], true);
  const optedSkills = await skillProviders();
  const optedMcp = await mcpProviders();
  console.log(`  opt-in 后技能 providers: ${fmt(optedSkills)} | MCP: ${fmt(optedMcp)}`);
  if (hasClaudePlugins) {
    assert((optedSkills.get("claude-plugins") ?? 0) > 0, `opt-in 后 ~/.claude/plugins 技能回到列表（claude-plugins=${optedSkills.get("claude-plugins") ?? 0}）`);
    assert((optedMcp.get("claude-plugins") ?? 0) > 0, `opt-in 后 ~/.claude/plugins MCP 回到列表（claude-plugins=${optedMcp.get("claude-plugins") ?? 0}）`);
  } else {
    console.log("  · 跳过 opt-in 正向断言：本机无 ~/.claude/plugins");
  }

  // 用例 4：只关 claude → 开关按来源粒度生效，其余外部来源仍可用
  await applySources(["claude"], [], true);
  const single = await skillProviders();
  assert((single.get("claude") ?? 0) === 0, "只关 claude 时 claude 技能为 0");
  assert((single.get("codex") ?? 0) > 0, `只关 claude 时 codex 来源仍可用（codex=${single.get("codex") ?? 0}）`);
} finally {
  await restore();
}
console.log("全部断言通过");
process.exit(0);
export {};
