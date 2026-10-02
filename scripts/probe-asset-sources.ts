// Probe: whether asset listings (skills / MCP) respect the extension page's source toggles.
// Regression defense: host/assets.ts once hard-coded enumeration of external dirs like ~/.claude/skills and ignored source state,
// so turning a source off on the extension page still left that source's skills listed on the skills page.
// Usage: bun scripts/probe-asset-sources.ts
// Forces the omp-desktop-test profile; restores the settings keys it changed on exit.
// OMP_PROFILE must be written to the env before host/bootstrap.ts is evaluated, hence the dynamic import.
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

// ~/.claude/plugins is one of this machine's external user-level sources (skill provider=claude-plugins; MCP same source)
const hasClaudePlugins = fs.existsSync(path.join(os.homedir(), ".claude", "plugins"));

// ---------- settings snapshot (restored before exit) ----------
const KEYS = ["disabledProviders", "enabledProviders", "skills.enableClaudeUser", "skills.enableCodexUser"] as const;
const snapshot = new Map<string, unknown>(KEYS.map((k) => [k, H.settings.get(k)]));
async function restore() {
  for (const [k, v] of snapshot) H.settings.set(k, v ?? (k.startsWith("skills.") ? false : []));
  await H.settings.flush();
}

// Write the source state and rebuild the base registry (disabledProviders only takes effect via initializeWithSettings)
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

// When this machine has no assets from a source, only verify absence after disabling; the positive assertion prints a skip
function assertAbsent(map: Map<string, number>, provider: string, what: string, off: Set<string>) {
  if (!off.has(provider)) return;
  assert((map.get(provider) ?? 0) === 0, `已关闭来源不出现在${what}列表：${provider}（本机计数 ${map.get(provider) ?? 0}）`);
}

try {
  // Case 1: all external sources off (skill-level compat switch also on) -> no entry of a disabled source may appear
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
  // A disabled source must remain on the extension page (row present, toggle clickable back) -- otherwise it can never be re-enabled
  const extPayload = await buildExtensionsPayload("profile");
  const claudeRow = extPayload.providers.find((p) => p.id === "claude");
  assert(claudeRow !== undefined && claudeRow.enabled === false, "关闭的来源仍出现在扩展页供应商清单（enabled=false，可重新开启）");

  // Case 2: all sources on but no opt-in for external tools ~/ config -> external user-level sources still absent; non-external sources unaffected
  await applySources([], [], true);
  const onSkills = await skillProviders();
  const onMcp = await mcpProviders();
  console.log(`  开来源未 opt-in 技能 providers: ${fmt(onSkills)}`);
  console.log(`  开来源未 opt-in MCP providers: ${fmt(onMcp)}`);
  assert((onSkills.get("agents") ?? 0) === agentsWithOff, `非外部来源（agents）不受来源开关影响（${agentsWithOff}）`);
  assert((onSkills.get("claude") ?? 0) > 0, `来源开启时 ~/.claude/skills 技能在列表（claude=${onSkills.get("claude") ?? 0}）`);
  assert((onSkills.get("claude-plugins") ?? 0) === 0, "未 opt-in 时外部用户级来源 ~/.claude/plugins 不出现（技能）");
  assert((onMcp.get("claude-plugins") ?? 0) === 0, "未 opt-in 时外部用户级来源 ~/.claude/plugins 不出现（MCP）");

  // Case 3: opt in to external tools ~/ config -> that source's assets return to the listing
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

  // Case 4: disable only claude -> toggles take effect per source; other external sources remain usable
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
