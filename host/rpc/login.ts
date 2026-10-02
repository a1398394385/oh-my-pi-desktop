// Login and credential domain RPC: browser-authorized login (onPrompt
// relayed through a UI dialog), logout, API key writing, login cancel and
// prompt replies, opening models.yml. Moved over from the main.ts message
// dispatch (third slice).
import path from "node:path";
import fs from "node:fs";
import { authPolicyFor } from "../bootstrap.ts";
import { H, loginPendingPrompts } from "../state.ts";
import { rebuildScopedModels, modelCatalog } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

export const loginHandlers: Record<string, RpcHandler> = {
  async provider_login(ws, msg) {
    // OMP login flow (AuthStorage.login): browser authorization + paste-code prompts relayed through a UI dialog
    const provider = String(msg.provider ?? "");
    if (!provider) throw new Error(hostI18n.t("errors.param.missingProvider"));
    if (H.loginInFlight) throw new Error(hostI18n.t("errors.login.inFlight"));
    H.loginInFlight = true;
    H.loginAbort = new AbortController();
    const reqId = msg.reqId ?? null;
    const wsRef = ws;
    const reply = (obj: Record<string, unknown>) => {
      try {
        wsRef.send(JSON.stringify({ reqId, ...obj }));
      } catch {}
    };
    reply({ type: "login_progress", provider, message: hostI18n.t("flows.login.starting") });
    let promptSeq = 0;
    try {
      const identity = await H.authStorage.login(provider, {
        signal: H.loginAbort.signal,
        onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
          if (H.loginAbort?.signal.aborted) return;
          const url = info.launchUrl ?? info.url;
          if (url) {
            try {
              Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
            } catch {}
          }
          reply({
            type: "login_progress",
            provider,
            message: info.instructions || hostI18n.t("flows.login.browserOpened"),
            url: url ?? "",
          });
        },
        onProgress: (message: string) => reply({ type: "login_progress", provider, message: String(message) }),
        onPrompt: (prompt: { message?: string; secret?: boolean }) =>
          new Promise<string>((resolve, reject) => {
            const id = ++promptSeq;
            loginPendingPrompts.set(id, resolve);
            H.loginAbort?.signal.addEventListener(
              "abort",
              () => {
                loginPendingPrompts.delete(id);
                reject(new Error("aborted"));
              },
              { once: true },
            );
            reply({ type: "login_prompt", provider, id, message: String(prompt.message ?? ""), secret: !!prompt.secret });
          }),
      });
      // Login succeeded: re-pull the model catalog (new credentials unlock providers) and push the latest list
      await H.modelRegistry.refresh();
      H.availableModels = H.modelRegistry.getAvailable();
      rebuildScopedModels();
      reply(modelsFrame());
      reply({ type: "models_catalog", models: modelCatalog() });
      reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
    } catch (err) {
      const aborted = H.loginAbort?.signal.aborted;
      reply({
        type: "login_done",
        provider,
        ok: false,
        cancelled: !!aborted,
        message: aborted ? hostI18n.t("flows.login.cancelled") : String((err as any)?.message ?? err),
      });
    } finally {
      H.loginInFlight = false;
      H.loginAbort = null;
    }
  },
  async provider_logout(ws, msg) {
    // Provider logout: after deleting the stored credential (local,
    // milliseconds) immediately filter and push the catalog locally so the
    // UI removes it instantly; the full modelRegistry.refresh() (per-provider
    // network discovery, seconds) converges afterwards and pushes again
    // (idempotent).
    // Hand-written apiKeys in models.yml outrank stored credentials, so the
    // UI offers no logout entry for those providers
    const provider = String(msg.provider ?? "");
    if (!provider) throw new Error(hostI18n.t("errors.param.missingProvider"));
    await H.authStorage.remove(provider);
    H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    try {
      await H.modelRegistry.refresh();
      H.availableModels = H.modelRegistry.getAvailable();
      rebuildScopedModels();
      ws.send(JSON.stringify(modelsFrame()));
      ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    } catch (err) {
      process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
    }
  },
  provider_login_cancel(_ws, _msg) {
    // Explicit user cancel (e.g. closed the login page): abort the in-flight login flow
    if (H.loginInFlight && H.loginAbort) H.loginAbort.abort();
    else throw new Error(hostI18n.t("errors.login.noneInFlight"));
  },
  async provider_set_key(ws, msg) {
    // Configure an API key: write to authStorage (api_key credential), then refresh the model catalog
    const provider = String(msg.provider ?? "");
    const key = String(msg.key ?? "").trim();
    if (!provider) throw new Error(hostI18n.t("errors.param.missingProvider"));
    if (!key) throw new Error(hostI18n.t("errors.login.keyEmpty"));
    // Login-type providers (oauth/device/custom) have their credentials
    // attached to catalog providers via browser authorization (store-as);
    // there is no same-named provider in the catalog, so storing an API key
    // would only create an orphaned "configured but never usable" credential
    const loginKind = authPolicyFor(provider)?.login?.kind;
    if (loginKind === "oauth-code" || loginKind === "device-code" || loginKind === "custom") {
      throw new Error(hostI18n.t("errors.login.browserOnly", { provider }));
    }
    H.authStorage.upsertCredential(provider, { type: "api_key", key });
    await H.modelRegistry.refresh();
    H.availableModels = H.modelRegistry.getAvailable();
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    ws.send(JSON.stringify({ type: "provider_key_done", provider, ok: true }));
  },
  login_prompt_reply(_ws, msg) {
    const resolve = loginPendingPrompts.get(Number(msg.id));
    if (resolve) {
      loginPendingPrompts.delete(Number(msg.id));
      resolve(String(msg.text ?? ""));
    }
  },
  open_models_config(ws, msg) {
    // "Manually add provider": open the config-layer models.yml (create an empty file if absent)
    const modelsPath = path.join(H.agentDir, "models.yml");
    try {
      if (!fs.existsSync(modelsPath)) fs.writeFileSync(modelsPath, "# omp provider config; edit per the docs\n");
      Bun.spawn(["open", modelsPath], { stdout: "ignore", stderr: "ignore" });
    } catch {}
    ws.send(JSON.stringify({ type: "models_config_path", path: modelsPath }));
  },
};
