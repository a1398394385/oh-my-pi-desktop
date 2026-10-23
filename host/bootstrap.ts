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
import { safeStderr } from "./stderr.ts";
import { hostI18n } from "./i18n/host.ts";

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
    safeStderr(hostI18n.t("errors.host.saveProfileFailed", { detail: String(err) }));
  }
}

const savedProfile = getSavedProfile();
// A host launched with the repo as cwd is always a dev/smoke run — the packaged
// app runs omp-host.exe with the user's project as cwd. getSavedProfile() falls
// back to desktop-profile.json (usually "default") when OMP_PROFILE is absent,
// so a smoke script that forgets to pass the env silently writes its sessions,
// prompt history and omp-desktop.json into the user's default profile. Fail at
// startup instead, so the mistake surfaces on the smoke run that caused it.
const fromSourceTree = fs.existsSync(path.join(process.cwd(), "host", "host.ts"));
if (fromSourceTree && savedProfile === "default") {
  throw new Error(hostI18n.t("errors.host.profileRequired"));
}
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
// Session file root (same source as listAllSessions' default sessionsRoot; used by the sidebar full-text search prefilter)
export const { getSessionsDir } = await import("@oh-my-pi/pi-utils/dirs");
// Steer queue operations (identify/retrieve unconsumed steering messages), used by the host's peek/edit/drop_queued RPCs
export const { isUserQueuedMessage, isHiddenUserCompanion, toRestoredQueuedMessage } = await import(
  "@oh-my-pi/pi-coding-agent/session/queued-messages"
);
// /btw side conversations: turn lifecycle + history sidecar (used by host/btw.ts)
export const { beginBtwTurn, runBtwTurn, patchLatestBtwTurn } = await import(
  "@oh-my-pi/pi-coding-agent/session/btw-turn"
);
export const { BtwHistoryStore, getBtwLatestTurn } = await import(
  "@oh-my-pi/pi-coding-agent/session/btw-history"
);
export const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/discovery");
export const { clearCache: clearCapabilityFsCache } = await import("@oh-my-pi/pi-coding-agent/capability/fs");
export const {
  setMcpServerEnabled,
  updateMCPServer,
  removeMCPServer,
  readDisabledServers,
  readEnabledServers,
} = await import("@oh-my-pi/pi-coding-agent/mcp/config-writer");
export const { connectToServer, disconnectServer, listTools } = await import("@oh-my-pi/pi-coding-agent/mcp/client");
// Dynamic import is load-order-mandated here, same as the line above (header: setProfile must precede the SDK graph)
export const { MCPTool } = await import("@oh-my-pi/pi-coding-agent/mcp/tool-bridge");
// Model roles (@role): catalog/metadata pure functions + a resolver from role value to concrete model (for the settings page role config)
export const { getKnownRoleIds, getRoleInfo, formatModelRoleAlias, MODEL_ROLE_IDS, roleCandidatePool } = await import(
  "@oh-my-pi/pi-coding-agent/config/model-roles"
);
export const { resolveModelRoleValue, resolveRoleChain } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
// Web-search engine table (lazy provider modules): the capability page asks each engine's
// explicit-availability predicate (key configured / free / local) for its flat search picker.
// Dynamic import like every SDK binding above: load-order-mandated (setProfile must precede the SDK graph).
export const { getSearchProvider } = await import("@oh-my-pi/pi-coding-agent");

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
// Plan-mode approval prompts: inlined as text from the host/prompts mirrors
// (bunfig [loader] ".md" = "text"), so the compiled exe carries them. Reading
// the SDK package at runtime is impossible in a standalone exe: the prompt
// files are outside the bundle graph and import.meta.resolve fails there,
// which killed plan approval with "Cannot find package
// '@oh-my-pi/pi-coding-agent'" (see .agents/BUGS.md). The package's exports
// map does not expose prompts/, so a direct package import is not an option
// either. Mirrors are verified against the installed SDK on every host:build;
// after a base upgrade run `bun run host:sync-prompts`.
import planModeApproved from "./prompts/plan-mode-approved.md";
import planModeCompactInstructions from "./prompts/plan-mode-compact-instructions.md";

const SDK_PROMPTS: Record<string, string> = {
  "plan-mode-approved.md": planModeApproved,
  "plan-mode-compact-instructions.md": planModeCompactInstructions,
};

export function readSdkPrompt(fileName: string): string {
  const text = SDK_PROMPTS[fileName];
  if (text === undefined) throw new Error(`unknown SDK prompt: ${fileName}`);
  return text;
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
export const { discoverSkills, discoverCustomTSCommands } = await import("@oh-my-pi/pi-coding-agent/sdk");
export const { SKILL_PROMPT_MESSAGE_TYPE } = await import("@oh-my-pi/pi-coding-agent/session/messages");
// grep / GrepOutputMode = the native ripgrep-core search the base's grep tool runs on
// (the sidebar full-text search sweeps the session corpus with it)
export const { fuzzyFind, grep, GrepOutputMode } = await import("@oh-my-pi/pi-natives");
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
// Manifest-declared plugin entries (tools/hooks/commands/extensions, features
// included) resolved to on-disk files — the plugins page's "what does this plugin
// introduce" attribution reuses the base's own resolution so the listing cannot
// drift from what the loader would pick up.
export const { resolvePluginManifestEntries } = await import(
  "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader"
);
// The base's own plugin installer (npm/git/local specs, same code path as
// `omp plugin install`) so the plugins page can install without the CLI.
export const { PluginManager } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/manager");
// The base CLI's own install-target classifier: tells a filesystem path (linked, so
// edits show up without a reinstall) apart from an npm/git specifier.
export const { classifyInstallTarget } = await import(
  "@oh-my-pi/pi-coding-agent/cli/classify-install-target"
);
// Plugin discovery caches on the base side (enabledPluginsCache keyed by cwd+home,
// plus the Claude/OMP installed-plugin registry roots). Install and refresh both
// invalidate first: without it the loader keeps serving the pre-install snapshot
// for the whole host lifetime.
export const { clearPluginRootsAndCaches } = await import(
  "@oh-my-pi/pi-coding-agent/discovery/helpers"
);
// Where a cwd's project-level plugins live (<anchor>/.omp/plugins, anchored at the
// nearest .omp else .git, never the user config root; null when no anchor exists).
// The plugins page scans and toggles at exactly this root so the UI and the base
// loader can never disagree about which directory a project section manages.
export const { resolveActiveProjectRegistryPath } = await import(
  "@oh-my-pi/pi-coding-agent/discovery/helpers"
);
// Session capabilities snapshot (right-panel page): LSP runtime status + memory backend status
export const { getLspStatus } = await import("@oh-my-pi/pi-coding-agent/lsp/servers");
export const { createSessionMemoryRuntimeContext } = await import("@oh-my-pi/pi-coding-agent/memory-backend/runtime");
// SSH host config (ssh.json) writer, shell quoting/argv guards, and the
// capability cache reset. Dynamic imports are load-order-mandated (header:
// setProfile must precede the coding-agent graph). After any ssh.json mutation
// the in-memory capability caches must be reset so ssh:// URL resolution
// re-reads the file (same reset the base's /ssh command performs).
export const { readSSHConfigFile, addSSHHost, updateSSHHost, removeSSHHost, validateHostName } = await import(
  "@oh-my-pi/pi-coding-agent/ssh/config-writer"
);
export const { reset: resetCapabilities } = await import("@oh-my-pi/pi-coding-agent/capability");
export const { sanitizeHostName, buildSshTarget } = await import("@oh-my-pi/pi-coding-agent/ssh/utils");
// Dynamic like every binding in this file: setProfile() must run first (see file header).
export const { quotePosixArgument } = await import("@oh-my-pi/pi-coding-agent/utils/shell-quote");
// Voice conversation (dictation + model management): the STTController
// coordinates native microphone capture with transcription; the downloader
// trio manages the local speech-model cache (status probe / download with
// progress); resolveSttModelSpec maps a catalog model id onto the downloader
// key. TTS runs UI-side on the system speechSynthesis, so the vocalizer is no
// longer imported. Dynamic like every SDK binding here: setProfile must
// precede the coding-agent graph (file-header constraint).
export const { STTController, isSttModelCached, downloadSttModel } = await import("@oh-my-pi/pi-coding-agent/stt");
export const { resolveSttModelSpec } = await import("@oh-my-pi/pi-coding-agent/stt/models");
