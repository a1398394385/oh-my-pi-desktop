// Settings domain RPC: base settings read/write, experimental switches
// (acp/sessionContext/hooks/plugins/skills), desktop env (proxy/certs),
// profile switching, approval mode and approval responses, plan-mode toggle.
// Moved over from the main.ts message dispatch (third slice).
import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { lookupSetting } from "../bootstrap.ts";
import { listPhysicalDisplays, reconcileComputerDisplay } from "../computer-display.ts";
import { H, sessions, pendingApprovals, type DesktopEnv } from "../state.ts";
import { rebuildScopedModels, settingsSnapshot } from "../models.ts";
import { settingsFrame, modelsFrame } from "../frames.ts";
import {
  readAcpRaw,
  writeAcpEnabled,
  writeSessionContextEnabled,
  applyProfile,
  applySleepPrevention,
  applyDesktopEnv,
} from "../profile.ts";
import { listAgentAssets, writeHooksEnabled, writePluginsEnabled } from "../assets.ts";
import { writeKeepaliveEnabled, writeKeepaliveConfig } from "../keepalive-config.ts";
import { setPlanMode } from "../plan.ts";
import { setComputerMode, pushComputerMode } from "../computer-mode.ts";
import { dispatchFromToolEnd } from "../plan-approve.ts";
import { writeUiLocale, writeUiPrefs } from "../ui-config.ts";
import { writeExternalBrowserEnabled } from "../browser-config.ts";
import { hostI18n, initHostI18n } from "../../ui-src/i18n/host.ts";
import { handleListSessions } from "./session";
import type { RpcHandler } from "./types";
import { openExternal } from "../open-external.ts";
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
    const { displays, error } = await listPhysicalDisplays();
    ws.send(JSON.stringify({ type: "displays", displays, error }));
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
    const raw = readAcpRaw();
    const acp = (raw.acp && typeof raw.acp === "object" ? raw.acp : {}) as Record<string, unknown>;
    const patch = (msg.config && typeof msg.config === "object" ? msg.config : {}) as Record<string, unknown>;
    await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, acp: { ...acp, ...patch } }, null, 2));
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
    try {
      ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
    } catch {}
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
  set_computer_mode(ws, msg) {
    // Computer-use toggle: the screen-icon button in the composer (per-session opt-in; the settings-page master gate is checked inside)
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    setComputerMode(ws, msg.sessionId, entry, msg.enabled === true);
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
    const pending = pendingApprovals.get(msg.requestId);
    if (!pending) throw new Error(hostI18n.t("errors.setting.approvalNotFound", { requestId: msg.requestId }));
    // The plan approval slider rides the same response; deliver it before
    // resolve() so the flow's continuation already sees the picked tier.
    if (pending.onSliderIndex && typeof msg.sliderIndex === "number") pending.onSliderIndex(msg.sliderIndex);
    // Plain approvals take the raw string; the ask-dialog variant's stored
    // resolve (session-lifecycle askDialog) parses the serialized
    // ExtensionAskDialogSubmitResult itself, so this stays pass-through.
    pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
    ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
  },
  ui_error(_ws, msg) {
    // Frontend uncaught-error reporting (WKWebView has no console; the dev terminal is the only outlet)
    safeStderr(`[ui] ${msg.message}\n`);
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
};
