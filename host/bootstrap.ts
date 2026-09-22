// SDK 加载顺序闸门（host 全域唯一约束，改动前先读懂这里）：
// - setProfile 必须先于 coding-agent 的 import：其模块在 import 时读取 agentDir
// - theme 是 pi-tui 的延迟初始化单例（export var theme 初始 undefined），TUI 启动流程才会
//   ensureThemeSync；headless 宿主必须在 coding-agent（含 ask 工具的 theme.status.success）加载前
//   初始化——Bun 对命名导入做快照，事后初始化救不了已加载的 ask.ts
//
// 因此任何模块需要 SDK 引用一律从本模块 import：本模块自身先 setProfile 再 await import，
// 其 import 方（经静态 import 触发本模块执行）天然获得正确顺序。
import { setProfile } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const desktopProfileConfigFile = path.join(os.homedir(), ".omp", "desktop-profile.json");
export function getSavedProfile(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(desktopProfileConfigFile, "utf8"));
    if (typeof raw.activeProfile === "string" && raw.activeProfile.trim()) {
      return raw.activeProfile.trim();
    }
  } catch {}
  return "omp-desktop";
}

export function saveProfileToDisk(profile: string) {
  try {
    const dir = path.dirname(desktopProfileConfigFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(desktopProfileConfigFile, JSON.stringify({ activeProfile: profile }, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(`[host] 保存 desktop-profile.json 失败: ${err}\n`);
  }
}

const savedProfile = getSavedProfile();
// setProfile 必须先于下列全部动态 import
setProfile(savedProfile === "default" ? undefined : savedProfile);

const { ensureThemeSync } = await import("@oh-my-pi/pi-tui/theme");
ensureThemeSync();

export const { getSupportedEfforts } = await import("@oh-my-pi/pi-catalog/model-thinking");
export const { getOAuthProviders } = await import("@oh-my-pi/pi-ai");
// 供应商授权策略（KDL 编译数据）：判定登录流类型（oauth-code/device-code/custom/api-key）
export const { authPolicyFor } = await import("@oh-my-pi/pi-catalog/compat/auth");
export const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry, USER_INTERRUPT_LABEL } =
  await import("@oh-my-pi/pi-coding-agent");
export const { Tokenizer } = await import("@oh-my-pi/pi-agent-core");
// steer 队列操作（未消费转向消息的识别/取回），供 host 的 peek/edit/drop_queued RPC 用
export const { isUserQueuedMessage, isHiddenUserCompanion, toRestoredQueuedMessage } = await import(
  "@oh-my-pi/pi-coding-agent/session/queued-messages"
);
export const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/discovery");
export const {
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  readDisabledServers,
  readEnabledServers,
} = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
export const { connectToServer, disconnectServer } = await import("@oh-my-pi/pi-coding-agent/mcp/client");
// 模型角色（@role）：目录/元数据纯函数 + 角色值 → 具体模型的解析器（设置页角色配置用）
export const { getKnownRoleIds, getRoleInfo, formatModelRoleAlias } = await import(
  "@oh-my-pi/pi-coding-agent/config/model-roles"
);
export const { resolveModelRoleValue } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");

// 启动时读到的持久化 profile（host.ts 启动序言写入 state.H 并执行首次 applyProfile）
export const initialProfile = savedProfile;

// 输入框 sigil：斜杠命令分发/清单、skill 分发、@ 文件候选（宿主与前端均经本模块取）。
// 无法用静态 import：setProfile 必须先于 coding-agent 加载（见文件头），SDK 引用一律走本模块的 await import
export const { executeAcpBuiltinSlashCommand } = await import(
  "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins"
);
export const { buildAvailableSlashCommands } = await import(
  "@oh-my-pi/pi-coding-agent/slash-commands/available-commands"
);
export const { parseSlashCommand } = await import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse");
// 计划模式（plan）：提案解析 + 批准后自动保存 + local:// 计划文件落盘路径换算
export const { resolveApprovedPlan } = await import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan");
export const { autosaveApprovedPlan } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave");
export const { resolveLocalUrlToPath } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
export const { normalizeLocalScheme } = await import("@oh-my-pi/pi-coding-agent/tools/path-utils");
export const { parseSkillInvocation, buildSkillPromptMessage } = await import(
  "@oh-my-pi/pi-coding-agent/extensibility/skills"
);
export const { SKILL_PROMPT_MESSAGE_TYPE } = await import("@oh-my-pi/pi-coding-agent/session/messages");
export const { fuzzyFind } = await import("@oh-my-pi/pi-natives");
