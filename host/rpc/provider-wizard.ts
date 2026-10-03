// Manual provider wizard RPC: probe a user-supplied OpenAI/Anthropic-compatible
// endpoint for its model list, then persist the picked models into the
// config-layer models.yml. Metadata fields the user leaves empty are omitted
// from the YAML on purpose — the base registry (finalizeCustomModel with
// useDefaults) fills them from the bundled catalog by model id at load time.
// The probe reply carries the same catalog match per model so the UI can show
// what would be inherited before saving; it also snapshots any custom metadata
// already saved in models.yml (saved) so the per-model toggle can prefill from it.
import fs from "node:fs";
import path from "node:path";
import { YAML } from "bun";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils";
import { getBundledModelReferenceIndex, resolveModelReference } from "@oh-my-pi/pi-catalog/identity";
import { discoverModelsByProviderType } from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { H } from "../state.ts";
import { refreshCatalogAndPush } from "./login.ts";
import hostI18n from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

// Request protocols offered by the wizard. All of them list models via the
// OpenAI `/models` shape; only the auth header style differs.
const WIZARD_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type WizardApi = (typeof WIZARD_APIS)[number];

function wizardApi(value: unknown): WizardApi {
  return typeof value === "string" && (WIZARD_APIS as readonly string[]).includes(value) ? (value as WizardApi) : "openai-completions";
}

function wizardHeaders(api: WizardApi, apiKey: string): Record<string, string> | undefined {
  if (!apiKey) return undefined;
  return api === "anthropic-messages"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

/** Catalog match slice shown in the UI as "would be inherited" placeholder values. */
function catalogMatchFor(modelId: string): Record<string, unknown> | null {
  const reference = resolveModelReference(modelId, getBundledModelReferenceIndex());
  if (!reference) return null;
  const thinking = reference.thinking;
  return {
    name: reference.name,
    contextWindow: reference.contextWindow ?? null,
    maxTokens: reference.maxTokens ?? null,
    reasoning: reference.reasoning ?? false,
    input: reference.input ?? null,
    supportsTools: reference.supportsTools ?? null,
    thinking: thinking ? { mode: thinking.mode, efforts: [...thinking.efforts], ...(thinking.defaultLevel ? { defaultLevel: thinking.defaultLevel } : {}) } : null,
    cost: reference.cost ?? null,
  };
}

/** Metadata already persisted for one model row (null when the row is absent/bare). */
function savedMetadataFor(row: unknown): Record<string, unknown> | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const hasCustom =
    r.name !== undefined || r.contextWindow !== undefined || r.maxTokens !== undefined || r.cost !== undefined ||
    r.reasoning !== undefined || r.input !== undefined || r.supportsTools !== undefined || r.thinking !== undefined;
  if (!hasCustom) return null;
  return {
    name: r.name ?? null,
    contextWindow: r.contextWindow ?? null,
    maxTokens: r.maxTokens ?? null,
    reasoning: r.reasoning ?? null,
    input: r.input ?? null,
    supportsTools: r.supportsTools ?? null,
    thinking: r.thinking ?? null,
    cost: r.cost ?? null,
  };
}

/** Normalize one wizard model payload into a YAML row: only edited fields are written. */
function buildModelRow(m: Record<string, unknown>): Record<string, unknown> {
  const id = String(m.id ?? "").trim();
  if (!id) throw new Error(hostI18n.t("errors.wizard.noModels"));
  const row: Record<string, unknown> = { id };
  const name = String(m.name ?? "").trim();
  if (name) row.name = name;
  const contextWindow = Number(m.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) row.contextWindow = contextWindow;
  const maxTokens = Number(m.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) row.maxTokens = maxTokens;
  const cost = m.cost as Record<string, unknown> | undefined;
  if (cost) {
    const parts = (["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => {
      const raw = cost[k];
      // "" / non-numeric = untouched (Number("") === 0 would fake zero-cost)
      if (typeof raw === "string" && raw.trim() === "") return [k, undefined] as const;
      const v = Number(raw);
      return [k, Number.isFinite(v) && v >= 0 ? v : undefined] as const;
    });
    // Any edited part writes the whole cost block; missing parts zero-fill (mirrors the UI)
    if (parts.some(([, v]) => v !== undefined)) {
      row.cost = Object.fromEntries(parts.map(([k, v]) => [k, v ?? 0]));
    }
  }
  // Capability fields: null/absent = inherit from the bundled catalog
  const reasoning = m.reasoning;
  if (reasoning !== undefined && reasoning !== null) row.reasoning = Boolean(reasoning);
  const input = m.input;
  if (input !== undefined && input !== null) {
    if (!Array.isArray(input) || input.some((x) => x !== "text" && x !== "image")) {
      throw new Error(hostI18n.t("errors.wizard.badInput"));
    }
    row.input = input.includes("image") ? ["text", "image"] : ["text"];
  }
  const supportsTools = m.supportsTools;
  if (supportsTools !== undefined && supportsTools !== null) row.supportsTools = Boolean(supportsTools);
  const thinking = m.thinking as Record<string, unknown> | undefined;
  if (thinking) {
    const mode = String(thinking.mode ?? "");
    const efforts = thinking.efforts;
    const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const MODES = ["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"];
    if (!MODES.includes(mode)) throw new Error(hostI18n.t("errors.wizard.badThinking"));
    if (!Array.isArray(efforts) || efforts.length === 0 || efforts.some((x) => !EFFORTS.includes(String(x)))) {
      throw new Error(hostI18n.t("errors.wizard.badThinking"));
    }
    const defaultLevel = String(thinking.defaultLevel ?? "");
    row.thinking = {
      mode,
      efforts: efforts.map(String),
      ...(defaultLevel ? { defaultLevel } : {}),
    };
  }
  return row;
}

/** Read models.yml (empty object when absent); a malformed file must surface, never be clobbered. */
function readModelsRoot(): Record<string, unknown> {
  const modelsPath = path.join(H.agentDir, "models.yml");
  try {
    return (YAML.parse(fs.readFileSync(modelsPath, "utf8")) as Record<string, unknown> | null) ?? {};
  } catch (err) {
    if (!isMissingFile(err)) throw err;
    return {};
  }
}

/** Write one provider back into models.yml; sibling hand-written fields (headers/compat/...) survive. */
function writeProvider(
  root: Record<string, unknown>,
  provider: string,
  baseUrl: string,
  api: WizardApi,
  apiKey: string,
  models: Array<Record<string, unknown>>,
): void {
  if (typeof root !== "object" || root === null) root = {};
  const providers = (root.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const next: Record<string, unknown> = { ...(providers[provider] ?? {}), baseUrl, api, models };
  if (apiKey) next.apiKey = apiKey;
  else delete next.apiKey;
  providers[provider] = next;
  root.providers = providers;
  fs.writeFileSync(path.join(H.agentDir, "models.yml"), stringifyYamlConfig(root));
}

export const wizardHandlers: Record<string, RpcHandler> = {
  async probe_provider_models(ws, msg) {
    const baseUrl = String(msg.baseUrl ?? "").trim();
    const apiKey = String(msg.apiKey ?? "").trim();
    const api = wizardApi(msg.api);
    if (!baseUrl) throw new Error(hostI18n.t("errors.wizard.missingBaseUrl"));
    // Optional provider id: when given, each probed model also snapshots its
    // already-saved custom metadata so the UI toggle can prefill from it.
    const provider = String(msg.provider ?? "").trim();
    let savedRows: Map<string, unknown> | null = null;
    if (provider && !/\s/.test(provider)) {
      try {
        const providers = (readModelsRoot().providers as Record<string, { models?: Array<Record<string, unknown>> }> | undefined) ?? {};
        savedRows = new Map((providers[provider]?.models ?? []).map((row) => [String(row.id), row]));
      } catch {
        savedRows = null; // unreadable models.yml: degrade to catalog-only prefill
      }
    }
    try {
      const models = await discoverModelsByProviderType(
        { provider: "wizard-probe", api, baseUrl, headers: wizardHeaders(api, apiKey), discovery: { type: "openai-models-list" } },
        { fetch, getBearerApiKeyResolver: async () => undefined },
      );
      ws.send(
        JSON.stringify({
          type: "provider_models_probe",
          models: models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            contextWindow: m.contextWindow ?? null,
            maxTokens: m.maxTokens ?? null,
            catalog: catalogMatchFor(m.id),
            saved: savedRows ? savedMetadataFor(savedRows.get(m.id)) : null,
          })),
        }),
      );
    } catch (err) {
      // ok:false reply instead of a throw: the wizard view attributes the failure itself
      ws.send(
        JSON.stringify({
          type: "provider_models_probe",
          models: [],
          failed: true,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },
  async save_provider_models(ws, msg) {
    const provider = String(msg.provider ?? "").trim();
    const baseUrl = String(msg.baseUrl ?? "").trim();
    const apiKey = String(msg.apiKey ?? "").trim();
    const api = wizardApi(msg.api);
    const picked = Array.isArray(msg.models) ? msg.models : [];
    if (!provider || /\s/.test(provider)) throw new Error(hostI18n.t("errors.wizard.invalidProviderName"));
    if (!baseUrl) throw new Error(hostI18n.t("errors.wizard.missingBaseUrl"));
    if (!picked.length) throw new Error(hostI18n.t("errors.wizard.noModels"));
    const models = picked.map((m: Record<string, unknown>) => buildModelRow(m));
    const root = readModelsRoot();
    writeProvider(root, provider, baseUrl, api, apiKey, models);
    // Same convergence as provider_set_key: registry re-reads models.yml and both model frames re-push
    await refreshCatalogAndPush(ws);
    ws.send(JSON.stringify({ type: "provider_models_saved", provider, count: models.length }));
  },
  // Per-model save from the metadata editor: upsert one row by id, leaving the
  // provider's other model rows untouched. Connection fields (baseUrl/api/apiKey)
  // are optional here: when the request omits them (provider-detail editor) the
  // persisted values stay as-is; the wizard sends them explicitly.
  async save_provider_model(ws, msg) {
    const provider = String(msg.provider ?? "").trim();
    const model = msg.model as Record<string, unknown> | undefined;
    if (!provider || /\s/.test(provider)) throw new Error(hostI18n.t("errors.wizard.invalidProviderName"));
    if (!model) throw new Error(hostI18n.t("errors.wizard.noModels"));
    const row = buildModelRow(model);
    const root = readModelsRoot();
    const providers = (root.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
    const previous = providers[provider] ?? {};
    const existing = (previous.models as Array<Record<string, unknown>> | undefined) ?? [];
    const at = existing.findIndex((m) => String(m.id) === String(row.id));
    const models = [...existing];
    if (at >= 0) models[at] = row;
    else models.push(row);
    const baseUrl = String(msg.baseUrl ?? "").trim() || String(previous.baseUrl ?? "");
    const apiKey = msg.apiKey === undefined ? String(previous.apiKey ?? "") : String(msg.apiKey).trim();
    const api = msg.api === undefined ? wizardApi(previous.api) : wizardApi(msg.api);
    if (!baseUrl) throw new Error(hostI18n.t("errors.wizard.missingBaseUrl"));
    writeProvider(root, provider, baseUrl, api, apiKey, models);
    await refreshCatalogAndPush(ws);
    ws.send(JSON.stringify({ type: "provider_model_saved", provider, model: row }));
  },
  // Provider-detail model list metadata snapshot: per model row of a persisted
  // (config-layer) provider — saved custom metadata plus the catalog match.
  async provider_model_meta(ws, msg) {
    const provider = String(msg.provider ?? "").trim();
    if (!provider) throw new Error(hostI18n.t("errors.wizard.invalidProviderName"));
    const providers = (readModelsRoot().providers as Record<string, Record<string, unknown>> | undefined) ?? {};
    const config = providers[provider] ?? null;
    const rows = (config?.models as Array<Record<string, unknown>> | undefined) ?? [];
    ws.send(
      JSON.stringify({
        type: "provider_model_meta",
        provider,
        exists: config !== null,
        models: rows.map((row) => {
          const id = String(row.id ?? "");
          return { id, saved: savedMetadataFor(row), catalog: catalogMatchFor(id) };
        }),
      }),
    );
  },
};

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
