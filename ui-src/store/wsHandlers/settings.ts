// Settings-center data-domain frames: login flow, providers and quotas, asset/memory/MCP editor
// replies, composer sigil candidates (slash command list / @ file matches). Moved over from
// store/ws.ts onMessage.
import { useAppStore } from "../index";
import { t } from "../../i18n";
import type { McpAssetsPayload } from "../../types/frames";
import type { HandlerSlice } from "./types";

export const settingsHandlers = {
  limits_result(msg) {
    useAppStore.setState((s) => ({ ctxLimits: msg }));
  },
  provider_limits_result(msg) {
    // Models-management page quotas: landed for the selected provider; components render from providerLimits (components check provider to prevent stale-response pollution)
    if (msg.provider === useAppStore.getState().selectedProvider) {
      useAppStore.setState((s) => ({ providerLimits: msg }));
    }
  },
  provider_accounts(msg) {
    // Models-management page account section: same stale-response guard as providerLimits
    if (msg.provider === useAppStore.getState().selectedProvider) {
      useAppStore.setState((s) => ({ providerAccounts: msg }));
    }
  },
  all_providers(msg) {
    useAppStore.setState((s) => ({ allProvidersCache: msg.providers ?? [] }));
  },
  login_progress(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    useAppStore.setState((s) => ({ loginBanner: t("notify.loginProgress", { provider: msg.provider, message: msg.message }) }));
  },
  login_prompt(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    useAppStore.setState((s) => ({ loginPromptData: msg }));
  },
  login_done(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    if (msg.ok) {
      useAppStore.getState().toast(t("notify.loginOk", { provider: msg.provider }));
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null, mpAddView: false }));
    } else if (msg.cancelled) {
      useAppStore.getState().toast(t("notify.loginCancelled"));
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
    } else {
      useAppStore.getState().toast(t("notify.loginFailed", { provider: msg.provider, message: msg.message }));
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
    }
  },
  provider_key_done(msg) {
    useAppStore.getState().toast(t("notify.apiKeySaved", { provider: msg.provider }));
    useAppStore.setState((s) => ({ mpDetailProv: null }));
    useAppStore.getState().send({ type: "get_all_providers" });
  },
  models_config_path(msg) {
    useAppStore.getState().toast(t("notify.configPath", { path: msg.path }));
  },
  asset_file(msg) {
    // Frame shared by the skills/agents/mcp editors; landed wholesale, pages filter by kind (each
    // fresh object assignment triggers the effect). The type field is added to build a complete
    // frame object (kind defaulting preserves the original behavior); the fresh object reference
    // drives the "saved" indicator reset
    useAppStore.setState((s) => ({
      assetFile: { type: "asset_file", kind: msg.kind ?? "agent", path: msg.path, content: msg.content },
    }));
  },
  memory_file(msg) {
    // The first directory-level read carries files; row expansion/rollout returns only content (semantics moved over from the old memInbox)
    useAppStore.setState((s) => {
      const md = s.memoryDetail;
      const next = msg.files
        ? {
            ...md,
            base: msg.path,
            files: msg.files,
            rollouts: msg.rollouts ?? [],
            active: { name: msg.file, rollout: false },
          }
        : { ...md };
      next.content = msg.content;
      next.status = "done";
      next.error = null;
      return { memoryDetail: next };
    });
  },
  asset_file_saved(msg) {
    const at = Date.now();
    useAppStore.setState((s) => ({ assetFileSaved: { kind: msg.kind, at }, assetSaved: { kind: msg.kind, at } }));
    useAppStore.getState().send({ type: "list_agent_assets" });
  },
  asset_file_deleted(msg) {
    useAppStore.getState().toast(t(msg.kind === "skill" ? "notify.skillDeleted" : "notify.fileDeleted"));
  },
  mcp_server_tested(msg) {
    // Moved over from the old handleMcpServerTested: land the test result + sync the row status dot + toast (wholesale reference swap)
    useAppStore.setState((st) => {
      // Per-field shape of the mcp section follows the base scan function (frames.ts TODO); only test-related fields of the servers array are read here
      const mcp = st.agentAssets?.mcp as { servers?: { name: string; status?: string; error?: string; log?: string }[] } | undefined;
      const servers = mcp?.servers;
      const srv = servers?.find((x) => x.name === msg.name);
      const mcpTestResults = { ...st.mcpTestResults, [msg.name]: { status: msg.status, error: msg.error, log: msg.log, ts: Date.now() } };
      if (!srv || !servers || !mcp) return { mcpTestResults };
      const nextServers = servers.map((x) =>
        x === srv ? { ...x, status: msg.status === "ok" ? "connected" : "error", error: msg.error, log: msg.log } : x,
      );
      return {
        mcpTestResults,
        // mcp reads servers through a narrowed type via as (the spread keeps all fields at runtime); the static-side assertion restores the full payload type
        agentAssets: { ...st.agentAssets!, mcp: { ...mcp, servers: nextServers } as McpAssetsPayload },
      };
    });
    useAppStore.getState().toast(
      msg.status === "ok"
        ? t("notify.mcpConnected", { name: msg.name })
        : t("notify.mcpProbeFailed", { name: msg.name, error: msg.error || "" }),
    );
  },
  // ---- Composer sigil: slash command list (host list_commands reply; @ candidates reply of list_files) ----
  commands(msg) {
    useAppStore.setState((s) => ({
      commands: Array.isArray(msg.commands) ? msg.commands : [],
      commandsSessionId: msg.sessionId ?? "new", // a reply without a session = the new-session page's list
    }));
  },
  file_matches(msg) {
    if (msg.reqId !== useAppStore.getState().mentionReqSeq) return; // stale response: the user kept typing, drop it
    useAppStore.setState((s) => ({
      mentionResult: { reqId: msg.reqId, matches: Array.isArray(msg.matches) ? msg.matches : [] },
    }));
  },
} satisfies HandlerSlice;

// Domain key set (for the exhaustive-assertion cross-check in index)
export type SettingsFrames = keyof typeof settingsHandlers;
