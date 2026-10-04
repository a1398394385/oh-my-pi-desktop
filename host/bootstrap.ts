// SDK load-order gate (the single repo-wide constraint for host — read this
// before changing anything):
// - setProfile must run before importing coding-agent: its modules read
//   agentDir at import time
// - theme is pi-tui's lazily initialized singleton (export var theme starts
//   undefined) and only the TUI startup flow calls ensureThemeSync; a headless
//   host must initialize it before loading coding-agent (which contains the
//   ask tool's theme.status.success) — Bun snapshots named imports, so
//   initializing later cannot save an already-loaded ask.ts
// - the SDK re-exports pi-tui/theme through its own resolution context: a
//   nested node_modules copy (pnpm-era leftover) is a DIFFERENT module
//   instance, and the ask tool reads that one — so theme must ALSO be
//   initialized via the SDK's re-export after the SDK import (no-op when
//   node_modules holds a single copy; measured 2026-10-02, ask crashed with
//   "undefined is not an object (evaluating 'b.status')")
//
// Hence any module needing SDK references must import from this module: this
// module itself runs setProfile first and then awaits its imports, so its
// importers (which trigger this module's execution via static import)
// naturally get the correct order.
import { setProfile } from "@oh-my-pi/pi-utils";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const desktopProfileConfigFile = path.join(os.homedir(), ".omp", "desktop-profile.json");
export function getSavedProfile(): string {
  if (process.env.OMP_PROFILE && process.env.OMP_PROFILE.trim()) {
    const profile = process.env.OMP_PROFILE.trim();
    if (profile !== "default") {
      const profileDir = path.join(os.homedir(), ".omp", "profiles", profile, "agent");
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    }
    return profile;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(desktopProfileConfigFile, "utf8"));
    if (typeof raw.activeProfile === "string" && raw.activeProfile.trim()) {
      return raw.activeProfile.trim();
    }
  } catch {}
  return "default";
}

export function saveProfileToDisk(profile: string) {
  if (process.env.OMP_PROFILE) return; // Skip overwriting the user's desktop-profile.json when a profile is pinned via env var (e.g. test mode)
  try {
    const dir = path.dirname(desktopProfileConfigFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(desktopProfileConfigFile, JSON.stringify({ activeProfile: profile }, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(`[host] 保存 desktop-profile.json 失败: ${err}\n`);
  }
}

const savedProfile = getSavedProfile();
// setProfile must precede all dynamic imports below
setProfile(savedProfile === "default" ? undefined : savedProfile);

const { ensureThemeSync } = await import("@oh-my-pi/pi-tui/theme");
ensureThemeSync();

export const { getSupportedEfforts } = await import("@oh-my-pi/pi-catalog/model-thinking");
export const { getOAuthProviders } = await import("@oh-my-pi/pi-ai");
// Provider auth policy (KDL-compiled data): decides the login flow type (oauth-code/device-code/custom/api-key)
export const { authPolicyFor } = await import("@oh-my-pi/pi-catalog/compat/auth");
export const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry, USER_INTERRUPT_LABEL, ensureThemeSync: ensureSdkThemeSync } =
  await import("@oh-my-pi/pi-coding-agent");
// Initialize whichever pi-tui/theme instance the SDK resolved (a nested
// node_modules copy is a separate module instance — see the header note)
ensureSdkThemeSync();
// Past session retrieval (read_session_context tool): lists and parses the Pi sessions persisted under the current profile
export const { listAllSessions, FileSessionStorage, loadEntriesFromFile } = await import(
  "@oh-my-pi/pi-coding-agent"
);
export const { Tokenizer } = await import("@oh-my-pi/pi-agent-core");
// Steer queue operations (identify/retrieve unconsumed steering messages), used by the host's peek/edit/drop_queued RPCs
export const { isUserQueuedMessage, isHiddenUserCompanion, toRestoredQueuedMessage } = await import(
  "@oh-my-pi/pi-coding-agent/session/queued-messages"
);
export const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/discovery");
export const { clearCache: clearCapabilityFsCache } = await import("@oh-my-pi/pi-coding-agent/capability/fs");
export const {
  setMcpServerEnabled,
  addMCPServer,
  updateMCPServer,
  removeMCPServer,
  readDisabledServers,
  readEnabledServers,
} = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
export const { connectToServer, disconnectServer, listTools } = await import("@oh-my-pi/pi-coding-agent/mcp/client");
// Dynamic import is load-order-mandated here, same as the line above (header: setProfile must precede the SDK graph)
export const { MCPTool } = await import("@oh-my-pi/pi-coding-agent/mcp/tool-bridge");
// Model roles (@role): catalog/metadata pure functions + a resolver from role value to concrete model (for the settings page role config)
export const { getKnownRoleIds, getRoleInfo, formatModelRoleAlias, MODEL_ROLE_IDS } = await import(
  "@oh-my-pi/pi-coding-agent/config/model-roles"
);
export const { resolveModelRoleValue } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");

// Persisted profile read at startup (the host.ts startup prologue writes state.H and performs the first applyProfile)
export const initialProfile = savedProfile;

// Composer sigils: slash-command dispatch/manifest, skill dispatch, @ file candidates (both host and frontend obtain them via this module).
// Static imports are impossible: setProfile must precede loading coding-agent (see file header), so SDK references all go through this module's await import
export const { executeAcpBuiltinSlashCommand } = await import(
  "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins"
);
export const { buildAvailableSlashCommands } = await import(
  "@oh-my-pi/pi-coding-agent/slash-commands/available-commands"
);
export const { parseSlashCommand } = await import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse");
// Plan mode: proposal parsing + post-approval autosave + local:// plan file path resolution
export const { resolveApprovedPlan } = await import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan");
export const { autosaveApprovedPlan } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave");
export const { resolveLocalUrlToPath, copyLocalArtifacts } = await import(
  "@oh-my-pi/pi-coding-agent/internal-urls"
);
// Plan-mode approval prompts: read from the SDK's prompt files at runtime so
// the approved turn carries the base TUI's exact wording (inline plan +
// per-step verification + todo tracking). Desktop has no bunfig
// [loader] ".md" = "text" entry (unlike oh-my-pi) and the package's exports
// map `./prompts/*` to a single level, so neither an import attribute nor
// `@oh-my-pi/pi-coding-agent/prompts/system/x.md` resolves — anchoring on an
// already-exported module's own path and walking up to the package src root.
export async function readSdkPrompt(fileName: string): Promise<string> {
  const srcRoot = new URL("../", import.meta.resolve("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan")).pathname;
  return await Bun.file(srcRoot + "prompts/system/" + fileName).text();
}
export const { resolveToCwd } = await import("@oh-my-pi/pi-coding-agent/tools/path-utils");
// xd://propose dispatch metadata: the out-of-band plan-approval trigger keys off
// it exactly like the base TUI's event-controller (host/plan-approve.ts).
export const { writeDeviceDispatch } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
// Settings registry (18.5.0): Settings' string-key get/set was replaced by
// registry handles; importing config/all-settings registers every domain's
// settings (the registry stays empty until then — the SDK main entry does not
// load it), so compat lookups and the settings-page schema snapshot need this.
export const { orderedSettings } = await import("@oh-my-pi/pi-coding-agent/config/all-settings");
export const { lookup: lookupSetting } = await import("@oh-my-pi/pi-coding-agent/config/registry");
export const { PROPOSE_DEVICE_NAME } = await import("@oh-my-pi/pi-tui/tools/resolve");
export const { parseSkillInvocation, buildSkillPromptMessage } = await import(
  "@oh-my-pi/pi-coding-agent/extensibility/skills"
);
// Settings registry handle for the skills group (18.5.0): replaces the removed
// Settings.getGroup("skills") in the creating-new page's skill discovery.
// Dynamic like every SDK import here: setProfile must precede the coding-agent
// graph (file-header constraint), which a static import would violate.
export const { cfgSkills } = await import("@oh-my-pi/pi-coding-agent/extensibility/settings");
// Skill discovery for the creating-new page's command list (same path an
// AgentSession runs; see rpc/prompt.ts pushNewSessionCommands)
export const { discoverSkills } = await import("@oh-my-pi/pi-coding-agent/sdk");
export const { SKILL_PROMPT_MESSAGE_TYPE } = await import("@oh-my-pi/pi-coding-agent/session/messages");
export const { fuzzyFind } = await import("@oh-my-pi/pi-natives");
// Extensions hub (ported from /extensions): unified discovery + provider toggles (consumed by host/extensions.ts)
export const { loadAllExtensions, toggleProvider, toggleUserSource } = await import(
  "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager"
);
export const {
  getAllProvidersInfo,
  isUserSourceEnabled,
  isProviderEnabled,
  isForeignUserProvider,
  getDisabledProviders,
  setDisabledProviders,
} = await import("@oh-my-pi/pi-coding-agent/discovery");
// Settings injection into the capability discovery registry: CLI entries
// (main.ts/ttsr-cli/read-cli) all call initializeWithSettings after
// Settings.init, syncing disabledProviders/enabledProviders into the in-memory
// registry; the host never called it before, so third-party sources the user
// disabled stayed "enabled" at the discovery layer (affecting both the
// extensions page and session loading)
export const { initializeWithSettings } = await import("@oh-my-pi/pi-coding-agent/discovery");
// Rule frontmatter parsing (extensions detail pane)
export const { parseRuleConditionAndScope, parseRuleAgents } = await import(
  "@oh-my-pi/pi-coding-agent/capability/rule"
);
// Tool file header description + slash command preview (extensions detail pane; pi-tui pure functions, invoked inside the host process)
export const { toolFileHeaderDescription } = await import(
  "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-runtime"
);
export const { commandPreview } = await import("@oh-my-pi/pi-tui/overlays/extensions/inspector-model");
export const { getEnabledPlugins } = await import(
  "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader"
);
// Session capabilities snapshot (right-panel page): LSP runtime status + memory backend status
export const { getLspStatus } = await import("@oh-my-pi/pi-coding-agent/lsp/servers");
export const { createSessionMemoryRuntimeContext } = await import("@oh-my-pi/pi-coding-agent/memory-backend/runtime");
