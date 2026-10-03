// Model domain RPC: session-level switching (set_model/set_thinking),
// enable/disable (set_enabled_model), role read/write, catalog snapshots and
// the provider list. Moved over from the main.ts message dispatch (third
// slice).
import { authPolicyFor, formatModelRoleAlias, resolveModelRoleValue } from "../bootstrap.ts";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { H, sessions, enabledDefaults } from "../state.ts";
import { modelCatalog, modelRolesPayload, rebuildScopedModels } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import { listAllProviders } from "../limits/index.ts";
import { collectUsageStats } from "../stats.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";
import { settingsGet, settingsSet } from "../settings-compat.ts";

export const modelsHandlers: Record<string, RpcHandler> = {
  async set_model(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    process.stderr.write(`[host] set_model: ${msg.model} role=${msg.role ?? "-"} entry=${!!entry}\n`);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    if (msg.role) {
      // Role pick (the composer menu's "Model Role" section): resolve the role
      // fresh and apply it through the CLI role path — the model change is
      // recorded with the role name so ctrl+p role cycling tracks the slot,
      // and an explicit ":level" on the role value is applied
      const resolved = resolveModelRoleValue(formatModelRoleAlias(msg.role), H.availableModels, { settings: H.settings });
      if (!resolved.model) throw new Error(hostI18n.t("errors.model.roleUnresolved", { role: msg.role }));
      await entry.session.applyRoleModel({
        role: msg.role,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        explicitThinkingLevel: resolved.explicitThinkingLevel,
      });
    } else {
      const target = H.scopedModels.find((m) => `${m.provider}/${m.id}` === msg.model);
      if (!target) throw new Error(hostI18n.t("errors.model.unknown", { model: msg.model }));
      await entry.session.setModel(target); // persist defaults to false; effective only in this session
      // Apply the ":thinking" default level carried by the enabledModels entry, same as CLI behavior
      const defaultLevel = enabledDefaults.get(msg.model);
      if (defaultLevel) entry.session.setThinkingLevel(defaultLevel);
    }
    const model = `${entry.session.model.provider}/${entry.session.model.id}`;
    // After a model switch, return the configured selector ("auto" or a
    // concrete level): the bottom-right shows the user-configured mode; the
    // capability-clamped effective value is send-parameter detail and never
    // reaches the UI
    ws.send(
      JSON.stringify({
        type: "session_model",
        sessionId: msg.sessionId,
        model,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      }),
    );
  },
  set_thinking(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    entry.session.setThinkingLevel(msg.level);
    // Return the configured selector ("auto" or a concrete level); the clamped effective value never reaches the UI
    ws.send(
      JSON.stringify({ type: "session_thinking", sessionId: msg.sessionId, level: entry.session.configuredThinkingLevel?.() ?? "auto" }),
    );
  },
  // Quick switch (ctrl+p / shift+ctrl+p): cycles the session through the roles
  // in the settings cycleOrder (default smol/default/slow) — the exact CLI
  // path (session.cycleRoleModels), keeping role-slot tracking; roles whose
  // configured model is missing/unavailable are skipped inside the SDK
  async cycle_model(ws, msg) {
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(hostI18n.t("errors.session.notFound", { sessionId: msg.sessionId }));
    const cycleOrder = (settingsGet(H.settings, "cycleOrder") as string[]).slice();
    const result = await entry.session.cycleRoleModels(cycleOrder, msg.direction === "backward" ? "backward" : "forward");
    if (!result) {
      // Mirrors the CLI's "Only one role model available" status (undefined =
      // zero or one resolvable role): not an error, just nothing to cycle
      ws.send(JSON.stringify({ type: "cycle_model", sessionId: msg.sessionId, ok: false }));
      return;
    }
    ws.send(
      JSON.stringify({
        type: "cycle_model",
        sessionId: msg.sessionId,
        ok: true,
        model: `${result.model.provider}/${result.model.id}`,
        role: result.role,
        thinking: entry.session.configuredThinkingLevel?.() ?? "auto",
      }),
    );
  },
  get_models_catalog(ws) {
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
  },
  async set_enabled_model(ws, msg) {
    const id = String(msg.id ?? "");
    const on = !!msg.enabled;
    if (!H.availableModels.some((m) => `${m.provider}/${m.id}` === id)) throw new Error(hostI18n.t("errors.model.unknown", { model: id }));
    let entries: string[] = (settingsGet(H.settings, "enabledModels") ?? []).slice();
    if (entries.length === 0) {
      entries = H.availableModels.map((m) => `${m.provider}/${m.id}`);
    }
    const without = entries.filter((e) => e.split(":")[0] !== id);
    if (on) {
      const prev = entries.find((e) => e.split(":")[0] === id);
      without.push(prev ?? id);
    }
      if (without.length === 0) throw new Error(hostI18n.t("errors.model.keepAtLeastOne"));
    settingsSet(H.settings, "enabledModels", without);
    await H.settings.flush();
    rebuildScopedModels();
    if (H.scopedModels.length === 0) throw new Error(hostI18n.t("errors.model.noneAfterFilter"));
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
  },
  get_model_roles(ws) {
    ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
  },
  async set_model_role(ws, msg) {
    // Any valid name may be written: edits known roles and also creates custom roles from the input menu (overwriting an old value of the same name)
    const role = String(msg.role ?? "");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role)) throw new Error(hostI18n.t("errors.model.invalidRoleName", { role }));
    // The UI writes only exact "provider/model" (or null to clear back to the default chain); aliases/suffixes are left for hand-editing settings.json
    const value = msg.value == null || msg.value === "" ? undefined : String(msg.value);
    if (value && !H.availableModels.some((m) => `${m.provider}/${m.id}` === value)) {
      throw new Error(hostI18n.t("errors.model.unknown", { model: value }));
    }
    H.settings.setModelRole(role, value);
    await H.settings.flush();
    ws.send(JSON.stringify({ type: "model_roles", roles: modelRolesPayload() }));
  },
  // Single-model connectivity test (settings page model row "test" button):
  // sends one minimal completion through the base's full protocol stack —
  // transport/API selection, credential resolution (resolver covers OAuth
  // minting + account rotation) and auth retry all run exactly as in a chat
  // turn. Replies with a provider_model_test frame (ok:false instead of a
  // throw so the row attributes the failure itself).
  async test_provider_model(ws, msg) {
    const id = String(msg.id ?? "");
    const model = H.availableModels.find((m) => `${m.provider}/${m.id}` === id);
    if (!model) throw new Error(hostI18n.t("errors.model.unknown", { model: id }));
    const started = Date.now();
    let reply = "";
    try {
      const message = await completeSimple(
        model,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        {
          apiKey: H.modelRegistry.resolver(model),
          disableReasoning: true,
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (message.stopReason === "error") throw new Error(message.errorMessage ?? "provider error");
      reply = Array.isArray(message.content)
        ? message.content.filter((c) => c.type === "text").map((c) => c.text).join("")
        : "";
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "provider_model_test",
          model: id,
          ok: false,
          latencyMs: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        type: "provider_model_test",
        model: id,
        ok: true,
        latencyMs: Date.now() - started,
        reply: reply.slice(0, 120),
      }),
    );
  },
  async get_usage_stats(ws) {
    ws.send(JSON.stringify({ type: "usage_stats", stats: await collectUsageStats() }));
  },
  get_all_providers(ws) {
    ws.send(
      JSON.stringify({
        type: "all_providers",
        providers: listAllProviders().map((p) => {
          let accounts = 0;
          try {
            accounts = H.authStorage.credentials.list(p.id).length;
          } catch {}
          const loginKind = authPolicyFor(p.id)?.login?.kind;
          return {
            ...p,
            // Login capability: only oauth-code/device-code/custom have a real
            // authorization flow (browser/device code/vendor-custom);
            // api-key providers in the base merely "paste a key and verify";
            // the detail page already has an API Key input, so no duplicate
            // entry
            login: loginKind === "oauth-code" || loginKind === "device-code" || loginKind === "custom",
            // Configured account count: active authStorage credentials (models.yml/env-layer configs not counted)
            accounts,
          };
        }),
      }),
    );
  },
};
