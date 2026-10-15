// Shared per-model metadata editor (inline .mem-expand): the "custom metadata"
// toggle plus the metadata inputs and the bottom-right Save button.
// Used by the manual provider wizard rows and by the provider-detail model list.
// Field prefill on toggle-on: saved custom value > catalog value > endpoint-reported.
// Toggle-off saves a bare row ({id}) — everything inherits the official catalog.
// Capability selects (input/reasoning/tools/thinking) are tri-state: empty = inherit.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../store";
import Icon from "../../Icon";
import type { ManualProbeCatalogMatch } from "../../types/frames";
import { claimDropdown, releaseDropdown } from "../../lib/dropdownExclusive";

// User-facing thinking levels, least → most intensive (mirrors the base Effort enum)
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Thinking transports a models.yml row may declare (mirrors ThinkingControlMode)
export const THINKING_MODES = ["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"] as const;

// Per-model user edits (strings = input values; empty string = not edited / inherit)
export interface ModelEdit {
  custom: boolean; // metadata toggle: off = bare row (inherit), on = explicit values
  name: string;
  contextWindow: string;
  maxTokens: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
  input: "" | "text" | "text-image"; // accepted modalities
  reasoning: "" | "on" | "off";
  supportsTools: "" | "on" | "off";
  thinkingMode: string; // "" = inherit
  thinkingEfforts: string[]; // empty = inherit
  thinkingDefault: string; // "" = inherit
}
export const EMPTY_EDIT: ModelEdit = {
  custom: false, name: "", contextWindow: "", maxTokens: "",
  costInput: "", costOutput: "", costCacheRead: "", costCacheWrite: "",
  input: "", reasoning: "", supportsTools: "", thinkingMode: "", thinkingEfforts: [], thinkingDefault: "",
};

/** numeric input parse: "" = untouched (Number("") === 0 would fake an edit) */
export function num(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** True when effort levels/default are set without a thinking mode (unsavable per the base schema) */
export function thinkingIncomplete(e: ModelEdit): boolean {
  return !e.thinkingMode && (e.thinkingEfforts.length > 0 || !!e.thinkingDefault);
}

/** Persisted-row shape for one model: bare row when the toggle is off, explicit values when on */
export function buildRow(modelId: string, e: ModelEdit): Record<string, unknown> {
  if (!e.custom) return { id: modelId };
  const row: Record<string, unknown> = { id: modelId };
  if (e.name.trim()) row.name = e.name.trim();
  const cw = num(e.contextWindow);
  if (cw !== undefined && cw > 0) row.contextWindow = cw;
  const mt = num(e.maxTokens);
  if (mt !== undefined && mt > 0) row.maxTokens = mt;
  const parts = {
    input: num(e.costInput),
    output: num(e.costOutput),
    cacheRead: num(e.costCacheRead),
    cacheWrite: num(e.costCacheWrite),
  };
  if (Object.values(parts).some((v) => v !== undefined)) {
    row.cost = {
      input: parts.input ?? 0,
      output: parts.output ?? 0,
      cacheRead: parts.cacheRead ?? 0,
      cacheWrite: parts.cacheWrite ?? 0,
    };
  }
  if (e.input) row.input = e.input === "text-image" ? ["text", "image"] : ["text"];
  if (e.reasoning) row.reasoning = e.reasoning === "on";
  if (e.supportsTools) row.supportsTools = e.supportsTools === "on";
  // The base schema requires efforts inside a thinking block — write only complete configs
  if (e.thinkingMode && e.thinkingEfforts.length > 0) {
    row.thinking = {
      mode: e.thinkingMode,
      efforts: e.thinkingEfforts,
      ...(e.thinkingDefault ? { defaultLevel: e.thinkingDefault } : {}),
    };
  }
  return row;
}

/** Toggle-on prefill, field by field: saved custom value > catalog value > endpoint-reported */
function prefillFrom(m: { name: string; catalog: ManualProbeCatalogMatch | null; saved: ManualProbeCatalogMatch | null; probedContext?: number | null; probedMaxTokens?: number | null }): ModelEdit {
  const pick = (k: "name" | "contextWindow" | "maxTokens"): string | number | null => {
    const saved = m.saved?.[k];
    if (saved != null) return saved;
    const catalog = m.catalog?.[k];
    if (catalog != null) return catalog;
    if (k === "name") return m.name;
    return (k === "contextWindow" ? m.probedContext : m.probedMaxTokens) ?? "";
  };
  const cost = m.saved?.cost ?? m.catalog?.cost ?? null;
  const str = (v: string | number | null) => (v != null && v !== "" ? String(v) : "");
  const tri = (v: boolean | null | undefined): "" | "on" | "off" => (v == null ? "" : v ? "on" : "off");
  const inputArr = m.saved?.input ?? m.catalog?.input ?? null;
  const thinking = m.saved?.thinking ?? m.catalog?.thinking ?? null;
  return {
    custom: true,
    name: str(pick("name")),
    contextWindow: str(pick("contextWindow")),
    maxTokens: str(pick("maxTokens")),
    costInput: str(cost?.input ?? null),
    costOutput: str(cost?.output ?? null),
    costCacheRead: str(cost?.cacheRead ?? null),
    costCacheWrite: str(cost?.cacheWrite ?? null),
    input: inputArr ? (inputArr.includes("image") ? "text-image" : "text") : "",
    reasoning: tri(m.saved?.reasoning ?? m.catalog?.reasoning),
    supportsTools: tri(m.saved?.supportsTools ?? m.catalog?.supportsTools),
    thinkingMode: thinking?.mode ?? "",
    thinkingEfforts: thinking?.efforts ?? [],
    thinkingDefault: thinking?.defaultLevel ?? "",
  };
}

/** placeholder for an unedited field: catalog match first, endpoint-reported value second */
function placeholderFor(edited: string, catalogValue: number | null | undefined, probedValue: number | null | undefined): string {
  if (edited) return "";
  if (catalogValue != null) return String(catalogValue);
  if (probedValue != null) return String(probedValue);
  return "";
}

// Generic tri-state dropdown (boxed .sel + .menu, same behavior as McpPage's Sel:
// click to toggle, checkmark on selection, click-outside close)
function MetaSel({ value, onChange, options, inheritLabel, disabled }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ v: string; label: string }>;
  inheritLabel: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node | null)) setOpen(false);
    };
    const close = () => setOpen(false);
    claimDropdown(close);
    document.addEventListener("click", onDoc);
    return () => {
      document.removeEventListener("click", onDoc);
      releaseDropdown(close);
    };
  }, [open]);
  const cur = value === "" ? inheritLabel : (options.find((o) => o.v === value)?.label ?? value);
  return (
    <div className="sel mcp-form-sel" ref={ref}>
      <button
        type="button"
        className="mcp-form-sel-btn"
        disabled={disabled}
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="mcp-form-sel-cur">{cur}</span>
        <span className="caret-svg"><Icon name="caret" size={12} /></span>
      </button>
      <div
        className={"menu" + (open ? " open" : "")}
        onClick={(ev) => {
          ev.stopPropagation();
          const mi = (ev.target as HTMLElement).closest(".mi") as HTMLElement | null;
          if (!mi) return;
          setOpen(false);
          onChange(mi.dataset.v ?? "");
        }}
      >
        <div className="mi" data-v="">
          <span className="ck" style={{ visibility: value === "" ? "visible" : "hidden" }}>✓</span>
          <span className="mi-label">{inheritLabel}</span>
        </div>
        {options.map((o) => (
          <div key={o.v} className="mi" data-v={o.v}>
            <span className="ck" style={{ visibility: value === o.v ? "visible" : "hidden" }}>✓</span>
            <span className="mi-label">{o.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ModelMetaEditorProps {
  modelId: string;
  displayName: string;
  catalog: ManualProbeCatalogMatch | null;
  saved: ManualProbeCatalogMatch | null;
  probedContext?: number | null; // wizard only: endpoint-reported context window
  probedMaxTokens?: number | null;
  saving: boolean;
  onSave: (row: Record<string, unknown>) => void;
  onEdit?: (e: ModelEdit) => void; // mirror of internal edit state (row label / batch save)
}

export default function ModelMetaEditor({ modelId, displayName, catalog, saved, probedContext, probedMaxTokens, saving, onSave, onEdit }: ModelMetaEditorProps) {
  const { t } = useTranslation();
  // Entry state mirrors what is already persisted: saved metadata = toggle on
  const [edit, setEdit] = useState<ModelEdit>(() => (saved ? prefillFrom({ name: displayName, catalog, saved, probedContext, probedMaxTokens }) : { ...EMPTY_EDIT }));
  // Capability fields live in a second-level expander; default open when the
  // persisted/prefilled edit actually carries any of them
  const hasAdv = (x: ModelEdit) => !!(x.input || x.reasoning || x.supportsTools || x.thinkingMode || x.thinkingEfforts.length > 0 || x.thinkingDefault);
  const [advOpen, setAdvOpen] = useState(() => hasAdv(edit));
  const update = (next: ModelEdit) => {
    setEdit(next);
    onEdit?.(next);
  };
  const e = edit;

  // Inherit-option label names the concrete catalog value when one is known
  const inheritLabel = (concrete: string | null) =>
    concrete ? t("settingsPage.model.wizardInheritWith", { value: concrete }) : t("settingsPage.model.wizardInherit");

  // Inherited thinking config (saved > catalog) shown as the efforts placeholder hint
  const inheritedThinking = saved?.thinking ?? catalog?.thinking ?? null;
  // Concrete inherited values named in each inherit-option label (null = catalog silent)
  const inheritedArr = saved?.input ?? catalog?.input ?? null;
  const inputInherited = !inheritedArr ? null : inheritedArr.includes("image") ? t("settingsPage.model.wizardInputImage") : t("settingsPage.model.wizardInputText");
  const reasoningInheritedRaw = saved?.reasoning ?? catalog?.reasoning;
  const reasoningInherited = reasoningInheritedRaw == null ? null : t(reasoningInheritedRaw ? "settingsPage.model.wizardStateOn" : "settingsPage.model.wizardStateOff");
  const toolsInheritedRaw = saved?.supportsTools ?? catalog?.supportsTools;
  const toolsInherited = toolsInheritedRaw == null ? null : t(toolsInheritedRaw ? "settingsPage.model.wizardToolsOn" : "settingsPage.model.wizardToolsOff");

  const onSaveClick = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation();
    if (thinkingIncomplete(e)) {
      toast(t("settingsPage.model.wizardThinkNeedMode"));
      return;
    }
    if (e.thinkingMode && e.thinkingEfforts.length === 0) {
      toast(t("settingsPage.model.wizardThinkNeedEfforts"));
      return;
    }
    onSave(buildRow(modelId, e));
  };

  return (
    <div className="mem-expand">
      <div className="mpw-meta-head">
        <div
          className={"tg" + (e.custom ? " on" : "")}
          title={t("settingsPage.model.wizardCustomMeta")}
          onClick={(ev) => {
            ev.stopPropagation();
            // On: prefill from saved custom metadata, else catalog, else endpoint values; off: reset to bare
            update(e.custom ? { ...EMPTY_EDIT } : prefillFrom({ name: displayName, catalog, saved, probedContext, probedMaxTokens }));
          }}
        >
          <i />
        </div>
        <span className="mpw-meta-label">{t("settingsPage.model.wizardCustomMeta")}</span>
      </div>
      <div className="mpw-meta-hint">
        {e.custom
          ? catalog
            ? t("settingsPage.model.wizardMetaHintCatalog")
            : t("settingsPage.model.wizardMetaHintPlain")
          : t("settingsPage.model.wizardMetaHintOff")}
      </div>
      <div className="mcp-form-row">
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardModelName")}</label>
          <input className="mcp-form-input" value={e.name} placeholder={displayName} disabled={!e.custom}
            onChange={(ev) => update({ ...e, name: ev.target.value })} />
        </div>
        <div className="mcp-form-group mcp-form-quarter">
          <label className="mcp-form-label">{t("settingsPage.model.wizardContext")}</label>
          <input className="mcp-form-input" inputMode="numeric" value={e.contextWindow} disabled={!e.custom}
            placeholder={placeholderFor(e.contextWindow, catalog?.contextWindow, probedContext ?? null)}
            onChange={(ev) => update({ ...e, contextWindow: ev.target.value })} />
        </div>
        <div className="mcp-form-group mcp-form-quarter">
          <label className="mcp-form-label">{t("settingsPage.model.wizardMaxOut")}</label>
          <input className="mcp-form-input" inputMode="numeric" value={e.maxTokens} disabled={!e.custom}
            placeholder={placeholderFor(e.maxTokens, catalog?.maxTokens, probedMaxTokens ?? null)}
            onChange={(ev) => update({ ...e, maxTokens: ev.target.value })} />
        </div>
      </div>
      <div className="mcp-form-row">
        {([
          ["costInput", "wizardCostIn", catalog?.cost?.input],
          ["costOutput", "wizardCostOut", catalog?.cost?.output],
          ["costCacheRead", "wizardCostRead", catalog?.cost?.cacheRead],
          ["costCacheWrite", "wizardCostWrite", catalog?.cost?.cacheWrite],
        ] as const).map(([field, labelKey, catVal]) => (
          <div className="mcp-form-group mcp-form-quarter" key={field}>
            <label className="mcp-form-label">{t("settingsPage.model." + labelKey)}</label>
            <input className="mcp-form-input" inputMode="decimal" value={e[field]} disabled={!e.custom}
              placeholder={catVal != null ? String(catVal) : ""}
              onChange={(ev) => update({ ...e, [field]: ev.target.value })} />
          </div>
        ))}
      </div>
      <div className="mcp-form-group mpw-adv-toggle">
        <button type="button" className="mcp-env-toggle" onClick={(ev) => { ev.stopPropagation(); setAdvOpen((v) => !v); }}>
          <span className="caret-svg"><Icon name={advOpen ? "chevronUp" : "chevronDown"} size={12} /></span>
          {t("settingsPage.model.wizardAdvSettings")}
        </button>
      </div>
      {advOpen ? (
      <>
      <div className="mcp-form-row">
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardInput")}</label>
          <MetaSel value={e.input} disabled={!e.custom}
            inheritLabel={inheritLabel(inputInherited)}
            options={[
              { v: "text", label: t("settingsPage.model.wizardInputText") },
              { v: "text-image", label: t("settingsPage.model.wizardInputImage") },
            ]}
            onChange={(v) => update({ ...e, input: v as ModelEdit["input"] })} />
        </div>
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardReasoning")}</label>
          <MetaSel value={e.reasoning} disabled={!e.custom}
            inheritLabel={inheritLabel(reasoningInherited)}
            options={[
              { v: "on", label: t("settingsPage.model.wizardStateOn") },
              { v: "off", label: t("settingsPage.model.wizardStateOff") },
            ]}
            onChange={(v) => update({ ...e, reasoning: v as ModelEdit["reasoning"] })} />
        </div>
      </div>
      <div className="mcp-form-row">
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardTools")}</label>
          <MetaSel value={e.supportsTools} disabled={!e.custom}
            inheritLabel={inheritLabel(toolsInherited)}
            options={[
              { v: "on", label: t("settingsPage.model.wizardToolsOn") },
              { v: "off", label: t("settingsPage.model.wizardToolsOff") },
            ]}
            onChange={(v) => update({ ...e, supportsTools: v as ModelEdit["supportsTools"] })} />
        </div>
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardThinkMode")}</label>
          <MetaSel value={e.thinkingMode} disabled={!e.custom}
            inheritLabel={inheritLabel(inheritedThinking?.mode ?? null)}
            options={THINKING_MODES.map((m) => ({ v: m, label: m }))}
            onChange={(v) => update({ ...e, thinkingMode: v })} />
        </div>
      </div>
      <div className="mcp-form-row">
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">
            {t("settingsPage.model.wizardThinkEfforts")}
            {e.thinkingEfforts.length === 0 && inheritedThinking?.efforts ? (
              <span className="mpw-ef-hint">{inheritedThinking.efforts.join(" · ")}</span>
            ) : null}
          </label>
          <div className="mpw-chips">
            {EFFORTS.map((lvl) => (
              <button key={lvl} type="button"
                className={"mpw-chip" + (e.thinkingEfforts.includes(lvl) ? " on" : "")}
                disabled={!e.custom}
                onClick={(ev) => {
                  ev.stopPropagation();
                  update({ ...e, thinkingEfforts: e.thinkingEfforts.includes(lvl) ? e.thinkingEfforts.filter((x) => x !== lvl) : [...e.thinkingEfforts, lvl] });
                }}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>
        <div className="mcp-form-group mcp-form-half">
          <label className="mcp-form-label">{t("settingsPage.model.wizardThinkDefault")}</label>
          <MetaSel value={e.thinkingDefault} disabled={!e.custom}
            inheritLabel={inheritLabel(inheritedThinking?.defaultLevel ?? null)}
            options={EFFORTS.map((l) => ({ v: l, label: l }))}
            onChange={(v) => update({ ...e, thinkingDefault: v })} />
        </div>
      </div>
      </>
      ) : null}
      <div className="mpw-meta-foot">
        <span className="sp" />
        <button type="button" className="save-btn" disabled={!e.custom || saving} onClick={onSaveClick}>
          {saving ? t("settingsPage.model.wizardModelSaving") : t("settingsPage.model.wizardModelSave")}
        </button>
      </div>
    </div>
  );
}
