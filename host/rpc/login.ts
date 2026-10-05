// Login and credential domain RPC: browser-authorized login (onPrompt
// relayed through a UI dialog), logout, API key writing, login cancel and
// prompt replies, opening models.yml. Moved over from the main.ts message
// dispatch (third slice).
import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import path from "node:path";
import fs from "node:fs";
import { authPolicyFor } from "../bootstrap.ts";
import { H, loginPendingPrompts } from "../state.ts";
import { rebuildScopedModels, modelCatalog, syncAvailableModels, capabilityKeysPayload } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import { fetchProviderAccountsLimits } from "../limits/index.ts";
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
      const identity = await H.authStorage.oauth.login(provider, {
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
      syncAvailableModels();
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
    await H.authStorage.credentials.remove(provider);
    H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
    H.allModels = H.allModels.filter((m) => m.provider !== provider);
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    ws.send(JSON.stringify({ type: "capability_keys", keys: capabilityKeysPayload() }));
    try {
      await H.modelRegistry.refresh();
      syncAvailableModels();
      rebuildScopedModels();
      ws.send(JSON.stringify(modelsFrame()));
      ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
      ws.send(JSON.stringify({ type: "capability_keys", keys: capabilityKeysPayload() }));
    } catch (err) {
      process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
    }
  },
  // ---- Per-account disable/restore (manual tombstones) ----
  // OMP has no user entry for "disable one account but keep the credential":
  // credentials.disable is public yet only auto-failure paths call it, and no
  // restore API exists at all. The host closes the loop:
  // - disable: SDK soft-delete (the tombstone row keeps full token material);
  // - restore: read the preserved credential back from agent.db (readonly
  //   SELECT — the SDK never surfaces token material of disabled rows) and
  //   re-upsert it; upsert re-inserts the row and the store purges the
  //   superseded tombstone by identity-key match.
  // The cause string doubles as the restore gate: auto-disabled tombstones
  // (invalid_grant / revoked) stay unrestorable so they cannot die twice.
  async provider_list_accounts(ws, msg) {
    const provider = String(msg.provider ?? "");
    if (!provider) throw new Error(hostI18n.t("errors.param.missingProvider"));
    await pushProviderAccounts(ws, provider);
  },
  async provider_disable_account(ws, msg) {
    const provider = String(msg.provider ?? "");
    const id = Number(msg.id);
    if (!provider || !Number.isInteger(id)) throw new Error(hostI18n.t("errors.param.missingProvider"));
    if (!(await H.authStorage.credentials.disable(id, MANUAL_DISABLE_CAUSE))) {
      throw new Error(hostI18n.t("errors.account.notFound"));
    }
    await pushProviderAccounts(ws, provider);
    await refreshCatalogAndPush(ws);
  },
  async provider_enable_account(ws, msg) {
    const provider = String(msg.provider ?? "");
    const id = Number(msg.id);
    if (!provider || !Number.isInteger(id)) throw new Error(hostI18n.t("errors.param.missingProvider"));
    let db: Database;
    try {
      db = new Database(getAgentDbPath(H.agentDir), { readonly: true });
    } catch {
      // No local credential store (e.g. auth-broker profile) — nothing to restore from
      throw new Error(hostI18n.t("errors.account.restoreUnsupported"));
    }
    try {
      const row = db
        .query("SELECT provider, credential_type, data FROM auth_credentials WHERE id = ? AND disabled_cause = ?")
        .get(id, MANUAL_DISABLE_CAUSE) as { provider: string; credential_type: string; data: string } | undefined;
      if (!row || row.provider !== provider) throw new Error(hostI18n.t("errors.account.notFound"));
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      const credential =
        row.credential_type === "api_key"
          ? { type: "api_key", key: parsed.key, ...(parsed.source === "login" ? { source: "login" } : {}) }
          : { type: "oauth", ...parsed };
      await H.authStorage.credentials.upsert(provider, credential);
    } finally {
      db.close();
    }
    await pushProviderAccounts(ws, provider);
    await refreshCatalogAndPush(ws);
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
    await H.authStorage.credentials.upsert(provider, { type: "api_key", key });
    await H.modelRegistry.refresh();
    syncAvailableModels();
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    // Warm the quota cache for the new credential now (fire-and-forget):
    // the 5-min background timer would otherwise leave the first ctx-card /
    // models-page hover cold-fetching the vendor
    let limitsBaseUrl = "";
    try {
      limitsBaseUrl = H.modelRegistry.getProviderBaseUrl(provider) ?? "";
    } catch {}
    void fetchProviderAccountsLimits(H.authStorage, provider, limitsBaseUrl).catch(() => {});
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    ws.send(JSON.stringify({ type: "capability_keys", keys: capabilityKeysPayload() }));
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

// Manual disable cause marker: exact-match restore key in provider_enable_account
const MANUAL_DISABLE_CAUSE = "disabled by user (omp-desktop)";

// Minimal ws surface used by the helpers below (full ws type is the dispatch shell's concern)
interface WsLike {
  send(data: string): void;
}

// provider_accounts reply frame: active rows via credentials.list, disabled
// rows via credentials.listDisabled (identity slice only, never token material)
async function pushProviderAccounts(ws: WsLike, provider: string) {
  const active = H.authStorage.credentials.list(provider).map((c) => ({
    id: c.id,
    label: c.credential?.type === "oauth" ? (c.credential.email ?? c.credential.accountId ?? c.credential.orgName ?? "") : "",
  }));
  const disabledRows = await H.authStorage.credentials.listDisabled(provider);
  ws.send(
    JSON.stringify({
      type: "provider_accounts",
      provider,
      active,
      disabled: disabledRows.map((d) => ({
        id: d.id,
        label: d.email ?? d.accountId ?? d.orgName ?? "",
        cause: d.cause,
        disabledAtMs: d.disabledAtMs ?? null,
        manual: d.cause === MANUAL_DISABLE_CAUSE,
      })),
    }),
  );
}

// Post-mutation catalog convergence (same flow as provider_logout's tail):
// disabling the last active credential removes the provider, restoring one
// brings it back — either way the registry re-discovers and both frames re-push
export async function refreshCatalogAndPush(ws: WsLike) {
  try {
    await H.modelRegistry.refresh();
  } catch (err) {
    process.stderr.write(`[host] 账号变更后模型目录刷新失败: ${err}\n`);
  }
  syncAvailableModels();
  rebuildScopedModels();
  ws.send(JSON.stringify(modelsFrame()));
  ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
  ws.send(JSON.stringify({ type: "capability_keys", keys: capabilityKeysPayload() }));
}
