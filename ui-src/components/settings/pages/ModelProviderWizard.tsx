// Settings · Model page · manual provider wizard (mpManualView under mpAddView):
// fill in provider name / baseUrl / request protocol / API key, probe the endpoint's
// model list over the wizard RPC, tick models, optionally edit metadata per model
// (inline .mem-expand rows), then persist the selection into the config-layer
// models.yml. Fields left empty are omitted from the saved row — the base registry
// auto-inherits them from the bundled catalog by model id (the probe reply carries
// the same match as placeholder values); endpoint-reported contextWindow/maxTokens
// are written only when the catalog has no match for that model id.
import { useEffect, useState } from "react";
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, toast } from "../../../store";
import Icon from "../../../Icon";
import type { ManualProbeModel } from "../../../types/frames";
import ModelMetaEditor, { EMPTY_EDIT, buildRow, thinkingIncomplete, type ModelEdit } from "../ModelMetaEditor";

// Request protocols offered by the wizard (host side keeps the same trio)
type WizardApi = "openai-completions" | "openai-responses" | "anthropic-messages";
const WIZARD_APIS: Array<{ v: WizardApi; labelKey: string }> = [
  { v: "openai-completions", labelKey: "settingsPage.model.wizardApiCompletions" },
  { v: "openai-responses", labelKey: "settingsPage.model.wizardApiResponses" },
  { v: "anthropic-messages", labelKey: "settingsPage.model.wizardApiAnthropic" },
];

// ModelEdit / EMPTY_EDIT / buildRow live in the shared ModelMetaEditor
// (wizard rows and the provider-detail model list share the same editor).

export default function ModelProviderWizard() {
  const { t } = useTranslation();
  const probe = useAppStore((s) => s.manualProbe);
  const probing = useAppStore((s) => s.manualProbing);
  const saving = useAppStore((s) => s.manualSaving);
  const modelSaving = useAppStore((s) => s.manualModelSaving);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState<WizardApi>("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [apiOpen, setApiOpen] = useState(false);
  // API-type dropdown joins the settings-wide exclusivity slot (this one has no
  // outside-click close of its own; picking an option leaves it open by design)
  useEffect(() => {
    if (!apiOpen) return;
    const close = () => setApiOpen(false);
    claimDropdown(close);
    return () => releaseDropdown(close);
  }, [apiOpen]);
  // ticked model ids + per-model edits + which row is expanded
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, ModelEdit>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const models = probe?.models ?? [];
  const probeFailed = probe?.failed === true;

  const onProbe = () => {
    if (!baseUrl.trim()) {
      toast(t("settingsPage.model.wizardBaseUrlRequired"));
      return;
    }
    setTicked(new Set());
    setEdits({});
    setExpanded(null);
    setBump({ manualProbing: true, manualProbe: null });
    send({ type: "probe_provider_models", baseUrl: baseUrl.trim(), api, apiKey: apiKey.trim(), provider: provider.trim() || undefined });
  };

  const onSave = () => {
    const name = provider.trim();
    if (!name || /\s/.test(name)) {
      toast(t("settingsPage.model.wizardProviderNameRequired"));
      return;
    }
    if (!baseUrl.trim()) {
      toast(t("settingsPage.model.wizardBaseUrlRequired"));
      return;
    }
    if (ticked.size === 0) {
      toast(t("settingsPage.model.wizardTickRequired"));
      return;
    }
    const picked = models.filter((m) => ticked.has(m.id));
    if (picked.some((m) => thinkingIncomplete(edits[m.id] ?? EMPTY_EDIT))) {
      toast(t("settingsPage.model.wizardThinkNeedMode"));
      return;
    }
    const rows = picked.map((m) => buildRow(m.id, edits[m.id] ?? EMPTY_EDIT));
    setBump({ manualSaving: true });
    send({ type: "save_provider_models", provider: name, baseUrl: baseUrl.trim(), api, apiKey: apiKey.trim(), models: rows });
  };

  // Per-model save from the expanded metadata editor (upserts one row by id);
  // the row arrives prebuilt from the shared ModelMetaEditor
  const onModelSaveRow = (m: { id: string }, row: Record<string, unknown>) => {
    const name = provider.trim();
    if (!name || /\s/.test(name)) {
      toast(t("settingsPage.model.wizardProviderNameRequired"));
      return;
    }
    if (!baseUrl.trim()) {
      toast(t("settingsPage.model.wizardBaseUrlRequired"));
      return;
    }
    setBump({ manualModelSaving: m.id });
    send({
      type: "save_provider_model",
      provider: name,
      baseUrl: baseUrl.trim(),
      api,
      apiKey: apiKey.trim(),
      model: row,
    });
  };

  const apiLabel = (v: WizardApi) => t(WIZARD_APIS.find((a) => a.v === v)!.labelKey);

  return (
    <div className="mpw" onClick={() => apiOpen && setApiOpen(false)}>
      <div className="mp-head">
        <b>{t("settingsPage.model.wizardTitle")}</b>
        <span className="sp" />
        <button type="button" className="save-btn" onClick={() => setBump({ mpManualView: false })}>
          {t("settingsPage.shared.collapse")}
        </button>
      </div>
      <div className="set-group-desc">{t("settingsPage.model.wizardDesc")}</div>

      {/* Connection form (mcp-form-* shared classes keep settings-page form language) */}
      <div className="mp-ml"><span>{t("settingsPage.model.wizardSectionConn")}</span></div>
      <div className="sem-body form">
        <div className="mcp-form-row">
          <div className="mcp-form-group mcp-form-half">
            <label className="mcp-form-label">{t("settingsPage.model.wizardProviderName")} <span className="req">*</span></label>
            <input
              type="text"
              className="mcp-form-input"
              placeholder={t("settingsPage.model.wizardProviderNamePh")}
              spellCheck="false"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </div>
          <div className="mcp-form-group mcp-form-half">
            <label className="mcp-form-label">{t("settingsPage.model.wizardApi")}</label>
            <div className="sel mpw-sel" onClick={(e) => { e.stopPropagation(); setApiOpen(!apiOpen); }}>
              {apiLabel(api)} <Icon name="caret" size={14} className="caret-svg" />
              <div className={"menu" + (apiOpen ? " open" : "")}>
                {WIZARD_APIS.map((a) => (
                  <div key={a.v} className="mi" data-v={a.v} onClick={() => setApi(a.v)}>
                    <span className="ck" style={{ visibility: api === a.v ? "visible" : "hidden" }}>✓</span>
                    <span className="mi-label">{apiLabel(a.v)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="mcp-form-row">
          <div className="mcp-form-group mcp-form-half">
            <label className="mcp-form-label">{t("settingsPage.model.wizardBaseUrl")} <span className="req">*</span></label>
            <input
              type="text"
              className="mcp-form-input mcp-form-code"
              placeholder="https://api.example.com/v1"
              spellCheck="false"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="mcp-form-group mcp-form-half">
            <label className="mcp-form-label">{t("settingsPage.model.wizardApiKey")}</label>
            <input
              type="password"
              className="mcp-form-input mcp-form-code"
              placeholder={t("settingsPage.model.wizardApiKeyPh")}
              spellCheck="false"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>
        <div className="mcp-form-group mpw-probe-row">
          <button type="button" className="save-btn" disabled={probing} onClick={onProbe}>
            {probing ? t("settingsPage.model.wizardProbing") : t("settingsPage.model.wizardProbe")}
          </button>
          {probeFailed ? <span className="mpw-err">{probe?.message}</span> : null}
          {!probeFailed && models.length > 0 ? (
            <span className="mpw-count">{t("settingsPage.model.wizardFoundCount", { count: models.length })}</span>
          ) : null}
        </div>
      </div>

      {/* Probed model list: tick rows, expand a row to edit metadata */}
      {models.length > 0 ? (
        <>
        <div className="mp-ml"><span>{t("settingsPage.model.modelList")}</span></div>
        <div className="mpw-list">
          {models.map((m) => {
            const e = edits[m.id] ?? EMPTY_EDIT;
            const open = expanded === m.id;
            const on = ticked.has(m.id);
            return (
              <div key={m.id}>
                <div
                  className={"mpw-mrow" + (open ? " on" : "")}
                  onClick={() => {
                    const next = new Set(ticked);
                    if (on) next.delete(m.id);
                    else next.add(m.id);
                    setTicked(next);
                  }}
                >
                  <input
                    type="checkbox"
                    className="mpw-check"
                    checked={on}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={() => {
                      const next = new Set(ticked);
                      if (on) next.delete(m.id);
                      else next.add(m.id);
                      setTicked(next);
                    }}
                  />
                  <span className="mpw-mid">{m.id}</span>
                  <span className="mpw-mname">{e.name.trim() || m.name}</span>
                  {m.catalog ? (
                    <span className="tag mpw-cat">{t("settingsPage.model.wizardCatalogHit")}</span>
                  ) : null}
                  <span className="sp" />
                  <button
                    type="button"
                    className="plus-btn mpw-caret"
                    title={t("settingsPage.model.wizardEditMeta")}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setExpanded(open ? null : m.id);
                    }}
                  >
                    <Icon name="caret" size={14} className={open ? "rot" : ""} />
                  </button>
                </div>
                {open ? (
                  <ModelMetaEditor
                    modelId={m.id}
                    displayName={m.name}
                    catalog={m.catalog}
                    saved={m.saved}
                    probedContext={m.contextWindow}
                    probedMaxTokens={m.maxTokens}
                    saving={modelSaving === m.id}
                    onEdit={(next) => setEdits({ ...edits, [m.id]: next })}
                    onSave={(row) => onModelSaveRow(m, row)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        </>
      ) : null}

      {/* Bottom action row */}
      <div className="mpw-actions">
        <span className="text-ui-sm text-faint">
          {t("settingsPage.model.wizardSelected", { count: ticked.size })}
        </span>
        <span className="sp" />
        <button type="button" className="confirm-btn" disabled={saving} onClick={onSave}>
          {saving ? t("settingsPage.model.wizardSaving") : t("settingsPage.model.wizardSave")}
        </button>
      </div>
    </div>
  );
}
