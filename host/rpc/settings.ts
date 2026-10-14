// Settings domain RPC: base settings read/write, experimental switches
// (acp/sessionContext/hooks/plugins/skills), desktop env (proxy/certs),
// profile switching, approval mode and approval responses, plan-mode toggle.
// Moved over from the main.ts message dispatch (third slice).
import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { lookupSetting } from "../bootstrap.ts";
import { logger } from "@oh-my-pi/pi-utils";
import { listPhysicalDisplays, reconcileComputerDisplay } from "../computer-display.ts";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
import type { DesktopSession } from "@oh-my-pi/pi-natives";
import { H, sessions, settleApprovalResponse, type DesktopEnv } from "../state.ts";
import { rebuildScopedModels, settingsSnapshot } from "../models.ts";
import { settingsFrame, modelsFrame } from "../frames.ts";
import {
  writeAcpEnabled,
  writeSessionContextEnabled,
  applyProfile,
  applySleepPrevention,
  applyDesktopEnv,
} from "../profile.ts";
import { readDesktopSection, writeDesktopSection } from "../desktop-json.ts";
import { listAgentAssets, writeHooksEnabled, writePluginsEnabled } from "../assets.ts";
import { writeKeepaliveEnabled, writeKeepaliveConfig } from "../keepalive-config.ts";
import { writeKimiAutoThinking } from "../kimi-thinking.ts";
import { setPlanMode } from "../plan.ts";
import { setComputerMode, pushComputerMode, writeComputerProvider, writeComputerDefaultEnabled, warmKimiCu } from "../computer-mode.ts";
import { dispatchFromToolEnd } from "../plan-approve.ts";
import { writeUiLocale, writeUiPrefs } from "../ui-config.ts";
import { writeExternalBrowserEnabled } from "../browser-config.ts";
import { hostI18n, initHostI18n } from "../../ui-src/i18n/host.ts";
import { handleListSessions } from "./session";
import type { RpcHandler } from "./types";
import { openExternal } from "../open-external.ts";
import { getInstalledEditors, openInEditor } from "../editors.ts";
import { settingsSet, settingsSchemaRecord } from "../settings-compat.ts";
import { safeStderr } from "../stderr.ts";

export const settingsHandlers: Record<string, RpcHandler> = {
  get_settings(ws) {
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  get_settings_schema(ws) {
    ws.send(JSON.stringify({ type: "settings_schema", schema: settingsSchemaRecord() }));
  },
  async reload_settings(ws) {
    // Local config files may have been hand-edited: reload from disk (model settings only) and push the new model list
    try {
      await H.settings.reloadFromDisk();
      rebuildScopedModels();
      ws.send(JSON.stringify(modelsFrame()));
      ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
    } catch (err) {
      safeStderr(`[host] reload_settings 失败: ${err}\n`);
    }
  },
  async set_setting(ws, msg) {
    const key = String(msg.key ?? "");
    let value = msg.value;
    const def = lookupSetting(key);
    if (!def) throw new Error(hostI18n.t("errors.unknownSetting", { key }));
    const t = def.type;
    if (t === "number") {
      if ((key === "compaction.thresholdPercent" || key === "compaction.thresholdTokens") && value === "default") {
        value = -1;
      } else if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n)) value = n;
      }
    }
    if (t === "boolean") {
      if (typeof value !== "boolean") throw new Error(hostI18n.t("errors.setting.mustBeBoolean", { key }));
    } else if (t === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(hostI18n.t("errors.setting.mustBeNumber", { key }));
    } else if (t === "string") {
      if (typeof value !== "string") throw new Error(hostI18n.t("errors.setting.mustBeString", { key }));
    } else if (t === "enum") {
      if (!def.enumValues?.includes(value)) throw new Error(hostI18n.t("errors.setting.mustBeOneOf", { key, values: def.enumValues?.join("/") ?? "" }));
    } else if (t === "array") {
      if (!Array.isArray(value)) throw new Error(hostI18n.t("errors.setting.mustBeArray", { key }));
      const d = def.default;
      if (Array.isArray(d) && d.every((x) => typeof x === "string") && d.length > 0 && !value.every((x) => typeof x === "string"))
        throw new Error(hostI18n.t("errors.setting.arrayItemString", { key }));
    } else if (t === "record") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(hostI18n.t("errors.setting.mustBeObject", { key }));
    }
    // Per-key extra validation: ask.timeout must be non-negative
    if (key === "ask.timeout" && (typeof value !== "number" || value < 0)) throw new Error(hostI18n.t("errors.setting.askTimeoutNonNegative"));
    // Voice gate: enabling dictation requires the resolved STT model to be
    // fully cached — otherwise the first push-to-talk would stall on a
    // multi-hundred-MB download the settings page was meant to preflight
    if (key === "stt.enabled" && value === true) {
      const { isDictationModelReady } = await import("../voice.ts");
      if (!(await isDictationModelReady())) throw new Error(hostI18n.t("errors.sttModelNotReady"));
    }
    settingsSet(H.settings, key, value);
    // Post-write side effect: sleep prevention must apply to the process immediately
    if (key === "power.sleepPrevention") applySleepPrevention(value);
    // Post-write side effect: closing the computer-use master gate force-kills
    // every live session's per-session opt-in (the pinned overlay in
    // session-lifecycle blocks parent forwarding, so an explicit sweep is needed)
    if (key === "computer.enabled" && value !== true) {
      const gate = lookupSetting("computer.enabled");
      if (gate)
        for (const [sid, entry] of sessions.entries()) {
          entry.session.settings.writeValue(gate, false, "override");
          pushComputerMode(ws, sid, entry); // force-close every live opt-in: the composer button must go dark
        }
    }
    // Model-related keys: rebuild the scoped catalog and push a models frame
    const isModelKey = ["enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage", "modelTags", "modelProviderOrder", "cycleOrder"].includes(key);
    if (isModelKey) rebuildScopedModels();
    await H.settings.flush();
    // Computer-use display pick: remember which physical monitor this id names.
    // The id itself is a Win32 handle that dies with the boot, so the pick is
    // recorded by EDID name + geometry and re-resolved on the next boot
    // (host/computer-display.ts).
    if (key === "computer.display") await reconcileComputerDisplay();
    if (isModelKey) ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async list_displays(ws) {
    // Enumerate physical displays through the natives desktop adapter for the
    // computer-control display dropdown (read-only; failures degrade to an
    // empty list + error). Same enumeration the boot-time reconciliation uses.
    // The capture-permission label is read before enumeration: with Screen
    // Recording denied listDisplays itself throws, and the page still needs the
    // label to offer the System Settings shortcut.
    let capturePermission = "unavailable";
    let session: DesktopSession | null = null;
    try {
      session = createDesktopSession({});
      capturePermission = String(session.capabilities.capturePermission ?? "unavailable");
    } finally {
      await session?.close().catch(() => {});
    }
    const { displays, error } = await listPhysicalDisplays();
    ws.send(JSON.stringify({ type: "displays", displays, error, capturePermission }));
  },
  open_screen_recording_settings(_ws) {
    // The macOS Screen Recording grant lives in System Settings → Privacy &
    // Security → Screen Recording and can only be made there: the TCC preflight
    // is non-prompting, so the app cannot ask for it itself. Other platforms
    // have no equivalent pane (their capture labels follow display enumeration).
    if (process.platform !== "darwin") return;
    openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  },
  set_locale(_ws, msg) {
    // UI locale switch, fire-and-forget per the frame protocol (the frontend
    // re-sends its persisted language on every ws open): persist to the ui
    // section of omp-desktop.json, then apply to the host i18n instance
    const lang = msg.lang;
    if (lang !== "zh-CN" && lang !== "en") throw new Error(hostI18n.t("errors.setting.invalidLocale", { lang }));
    writeUiLocale(lang);
    initHostI18n(lang);
  },
  set_ui_prefs(ws, msg) {
    // Desktop-owned appearance settings (theme/motion/prefs): merge-write the
    // ui section of omp-desktop.json, then ack with a fresh settings frame —
    // the frame's uiConfig is read back from disk, so the frontend reconciles
    // its localStorage cache against what actually landed (stale-cache guard)
    writeUiPrefs({ theme: msg.theme, motion: msg.motion, prefs: msg.prefs });
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  set_external_browser(ws, msg) {
    // Desktop-owned browser routing switch: persists browser.external in
    // omp-desktop.json and applies it to the base settings immediately — off
    // pins browser.relay/browser.cdpUrl to "no external browser" on the runtime
    // override layer (config.yml is never rewritten, so flipping the switch
    // back on restores the user's own external routes), on clears the override
    // so those routes apply again. A fresh settings frame carries the state the
    // base actually ended up with, so the frontend reconciles against it.
    writeExternalBrowserEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_acp_enabled(ws, msg) {
    // Experimental features page switch: writes acp.enabled in
    // omp-desktop.json (affects only sessions created afterwards — the tool
    // surface and context extension are injected in createSessionCore and
    // cannot be hot-swapped into already-open sessions)
    await writeAcpEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_acp_config(ws, msg) {
    // Experimental features page: update the acp config section of omp-desktop.json
    const patch = (msg.config && typeof msg.config === "object" ? msg.config : {}) as Record<string, unknown>;
    writeDesktopSection("acp", { ...readDesktopSection("acp"), ...patch });
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_session_context_enabled(ws, msg) {
    // Experimental features page switch: writes sessionContext.enabled in omp-desktop.json (same as above; affects only sessions created afterwards)
    await writeSessionContextEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_keepalive_enabled(ws, msg) {
    // Experimental features page switch: writes keepalive.enabled in
    // omp-desktop.json (affects only sessions created afterwards; probe
    // parameters live in the keepalive section's other fields, per-profile)
    writeKeepaliveEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_keepalive_config(ws, msg) {
    // Experimental features page parameters: read-merge-write the keepalive
    // section of omp-desktop.json (duration/USD fields accept "8m"/"$1.5"
    // strings; invalid values skip the field. Extension instances of open
    // sessions never re-read disk — writes affect only sessions created
    // afterwards)
    writeKeepaliveConfig((msg.config && typeof msg.config === "object" ? msg.config : {}) as Record<string, unknown>);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_kimi_auto_thinking(ws, msg) {
    // Providers page switch: writes kimi.autoThinking in omp-desktop.json —
    // whether Kimi models are offered the `auto` thinking level. Takes effect
    // on the next thinking-level pick/session create (existing sessions keep
    // their configured level; Kimi + auto + off pins to `high`).
    writeKimiAutoThinking(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_hooks_enabled(ws, msg) {
    // Hooks master switch: writes hooks.enabled in omp-desktop.json (affects only sessions created afterwards)
    await writeHooksEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_plugins_enabled(ws, msg) {
    // Plugins master switch: writes plugins.enabled in omp-desktop.json (affects only sessions created afterwards)
    await writePluginsEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_skills_enabled(ws, msg) {
    // Skills master switch: writes skills.enabled to the base settings.json (consumed by every getGroup("skills") load site)
    settingsSet(H.settings, "skills.enabled", !!msg.enabled);
    await H.settings.flush();
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_desktop_env(ws, msg) {
    const next: DesktopEnv = {
      httpProxy: String(msg.httpProxy ?? "").trim(),
      noProxy: String(msg.noProxy ?? "").trim(),
      caCerts: String(msg.caCerts ?? "").trim(),
    };
    await writeFile(H.desktopEnvPath, JSON.stringify(next, null, 2));
    H.desktopEnv = next;
    H.desktopEnvFilePresent = true;
    applyDesktopEnv(next);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame(), restartHint: true }));
  },
  async switch_profile(ws, msg) {
    const p = String(msg.profile ?? "").trim();
    if (!p) throw new Error(hostI18n.t("errors.setting.profileEmpty"));
    await applyProfile(p);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify(modelsFrame()));
    await handleListSessions(ws);
    // Asset scan failure must stay observable: swallowing it here silently
    // strands the settings pages on a stale asset list (A5)
    let assets;
    try {
      assets = await listAgentAssets();
    } catch (err) {
      safeStderr(`[host] switch_profile agent assets scan failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (assets) ws.send(JSON.stringify({ type: "agent_assets", assets }));
    ws.send(JSON.stringify({ type: "profile_switched", profile: H.currentProfile }));
  },
  set_approval_mode(ws, msg) {
    const mode = msg.mode;
    if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
      throw new Error(hostI18n.t("errors.setting.invalidApprovalMode", { mode }));
    }
    // Resolved at execute time: no session rebuild needed, effective on the next tool call (applies to all sessions — settings are process-wide shared)
    const approvalMode = lookupSetting("tools.approvalMode");
    if (approvalMode) H.settings.writeValue(approvalMode, mode, "override");
    ws.send(JSON.stringify({ type: "approval_mode", mode }));
  },
  set_plan_mode(ws, msg) {
    // Plan-mode toggle: entered from the permission-mode menu in the UI, exited via the "Plan" button right of the permission pill
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    setPlanMode(ws, msg.sessionId, entry, msg.enabled === true);
  },
  async set_computer_mode(ws, msg) {
    // Computer-use toggle: the screen-icon button in the composer (per-session opt-in; the settings-page master gate is checked inside). Provider-aware: default drives the builtin eval prelude, kimi mounts the kimi-cu MCP server into this session's tool surface mid-session.
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    await setComputerMode(ws, msg.sessionId, entry, msg.enabled === true);
  },
  set_computer_provider(ws, msg) {
    // Desktop-owned computer-use provider pick (omp-desktop.json computer.provider):
    // "default" keeps the builtin flow; "kimi" reroutes the composer screen-icon
    // toggle to the builtin kimi-cu MCP server (mcp-builtin.ts, never in
    // mcp.json). Affects only subsequent toggles — live sessions keep whatever
    // they already mounted. Picking kimi warms the shared connection pool.
    const provider = msg.provider === "kimi" ? "kimi" : "default";
    writeComputerProvider(provider);
    warmKimiCu();
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  set_computer_default(ws, msg) {
    // Desktop-owned "default on" switch (omp-desktop.json computer.defaultEnabled):
    // fresh sessions start with computer use enabled. Spawn-time read only, so no
    // live session is touched — the settings frame below just echoes the new value.
    writeComputerDefaultEnabled(msg.enabled === true);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  /**
   * Smoke-only: replay a `write` to xd://propose so the plan-approval card can
   * be exercised without a model. Gated on OMP_PLAN_APPROVE_SMOKE=1, which only
   * the smoke script sets; without it the frame is a no-op, so a real build can
   * never be driven down the approval path by a stray client.
   */
  smoke_plan_propose(ws, msg) {
    if (process.env.OMP_PLAN_APPROVE_SMOKE !== "1") return;
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    dispatchFromToolEnd(ws, msg.sessionId, entry, "write", {
      details: {
        xdev: {
          tool: "propose",
          mode: "execute",
          args: { title: String(msg.title ?? "smoke") },
          inner: { planFilePath: String(msg.planFilePath), title: String(msg.title ?? "smoke"), planExists: true },
        },
      },
    });
  },
  approval_response(ws, msg) {
    // Settle logic lives beside requestApproval in state.ts (A11): the approval
    // state machine (pending table + request + settle) has one module boundary;
    // this entry is registration only.
    settleApprovalResponse(ws, msg);
  },
  ui_error(_ws, msg) {
    // Frontend uncaught-error reporting (WKWebView has no console). Two outlets:
    // the base logger's rotating file (the only sink that survives in a packaged
    // app — its stderr has no terminal to write to) and stderr for the dev terminal.
    const message = String(msg.message ?? "");
    logger.warn(`[ui] ${message}`, { source: "ui" });
    safeStderr(`[ui] ${message}\n`);
  },
  async open_folder(_ws, msg) {
    const raw = String(msg.path ?? "");
    if (raw) {
      try {
        if (!fs.existsSync(raw)) await mkdir(raw, { recursive: true });
        openExternal(raw);
      } catch {}
    }
  },
  async open_with(_ws, msg) {
    // Right-panel file menu: unknown editor / missing path / failed launch throw, the error frame toasts
    await openInEditor(String(msg.editorId ?? ""), String(msg.path ?? ""));
  },
  async list_editors(ws) {
    // Installed editors/terminals/file managers for the open-with menu (probed once per host run)
    ws.send(JSON.stringify({ type: "editors", editors: await getInstalledEditors() }));
  },
};
