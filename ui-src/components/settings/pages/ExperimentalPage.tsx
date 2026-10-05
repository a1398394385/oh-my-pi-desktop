// Settings page: experimental features (pg-experimental).
// Section 1: ACP context compaction (master switch + thresholds / target line / context window / candidate suggestions / user message protection)
// Section 2: sessions & retrieval (past-session retrieval read_session_context)
// Section 3: cache warming (desktop port of pi-kimi-keepalive, master switch + configurable
// probe parameters; omp-desktop.json lives independently per profile)
// Styling language matches the appearance page: set-page / set-tt / set-group-tt / set-group-desc / set-card / .srow / .tg / .sel / .inp.
import { useEffect, useState, type ReactNode } from "react";
import { saveUiPrefs } from "../../../appearance";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import Icon from "../../../Icon";
import { EnabledModelPicker } from "../../ModelPicker";
import type { AcpConfig } from "../../../types/frames";

const MAX_LIMIT_OPTIONS = ["35%", "45%", "50%", "55%", "60%", "70%", "80%"];
const MIN_LIMIT_OPTIONS = ["25%", "35%", "40%", "45%", "50%", "60%"];

interface SelOption {
  v: string;
  label: ReactNode;
  ck?: string;
}

function Sel({
  label,
  options,
  onPick,
  disabled,
}: {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div
      className={"sel" + (disabled ? " disabled" : "")}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {label} <Icon name="caret" size={14} className="caret-svg" />
      {open && (
        <div className="menu open">
          {options.map((o) => (
            <div
              key={o.v}
              className="mi"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(o.v);
              }}
            >
              <span className="ck">{o.ck ?? ""}</span>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Format ms → "8m"/"1h30m"/"45s" for display (the host-side parser accepts the same syntax for writes) */
function fmtDur(ms: number): string {
  if (ms <= 0) return "0";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec ? `${sec}s` : ""}`;
  return `${sec}s`;
}

/** Keepalive parameter row input (controlled + commit on blur + push-back refresh of the true value, following the ACP context window input pattern) */
function KaInput({
  value,
  placeholder,
  disabled,
  onSubmit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="srow-ctl">
      <input
        className={"inp" + (disabled ? " disabled" : "")}
        style={{ width: 170 }}
        placeholder={placeholder}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v.trim() !== value) onSubmit(v.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
}

export default function ExperimentalPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);

  const known = typeof hostSettings?.acpEnabled === "boolean";
  const enabled = known && !!hostSettings?.acpEnabled;
  const ctxKnown = typeof hostSettings?.sessionContextEnabled === "boolean";
  const ctxEnabled = ctxKnown && !!hostSettings?.sessionContextEnabled;
  const kaKnown = typeof hostSettings?.keepaliveEnabled === "boolean";
  const kaEnabled = kaKnown && !!hostSettings?.keepaliveEnabled;
  const kaConfig = hostSettings?.keepaliveConfig;
  const kaMode = kaConfig?.mode ?? "default";
  const kaTargets = kaConfig?.targets ?? [];
  const ringCount = useAppStore((s) => s.uiPrefs.ctxRingProbeCount);
  const modelNames = useAppStore((s) => s.modelNames);
  const modelCatalog = useAppStore((s) => s.modelCatalog); // chip display names (covers disabled picked targets too)

  const acpConfig = hostSettings?.acpConfig;
  const maxLimit = acpConfig?.maxContextLimit || "55%";
  const minLimit = acpConfig?.minContextLimit || "45%";
  const candidates = acpConfig?.candidates ?? false;
  const protectUser = acpConfig?.protectUserMessages ?? true;
  const sysPrompt = acpConfig?.systemPrompt ?? false;

  const [cwInput, setCwInput] = useState(acpConfig?.contextWindow || "");
  useEffect(() => {
    setCwInput(acpConfig?.contextWindow || "");
  }, [acpConfig?.contextWindow]);

  const updateAcp = (patch: Partial<AcpConfig>) => {
    send({ type: "set_acp_config", config: patch });
    if (typeof patch.enabled === "boolean") {
      send({ type: "set_acp_enabled", enabled: patch.enabled });
    }
  };

  // Keepalive parameter write-back: the host reads-merges-writes the keepalive section of
  // omp-desktop.json (invalid values ignore that field and push the true value back to refresh the input)
  const updateKa = (patch: Record<string, unknown>) => {
    send({ type: "set_keepalive_config", config: patch });
  };

  return (
    <div className="set-page" id="pg-experimental">
      <div className="set-tt">{t("settingsPage.nav.experimental")}</div>

      {/* Section 1: ACP context compaction */}
      <div className="set-group-tt">{t("settingsPage.exp.acpGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.exp.acpGroupDesc")}</div>
      <div className="set-card">
        {/* 1. Master switch */}
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              {t("settingsPage.exp.acpTitle")}
              <span className="srow-wn-inline">{t("settingsPage.exp.restartCacheWarn")}</span>
            </b>
            <span>{t("settingsPage.exp.acpDesc")}</span>
          </div>
          <div
            className={"tg" + (enabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgAcp"
            onClick={() => updateAcp({ enabled: !enabled })}
          >
            <i></i>
          </div>
        </div>

        {/* 2. Start-reminder threshold (soft reminder) */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.softTitle")}</b>
            <span>{t("settingsPage.exp.softDesc")}</span>
          </div>
          <Sel
            label={minLimit}
            disabled={!enabled}
            options={MIN_LIMIT_OPTIONS.map((v) => ({
              v,
              label: v === "45%" ? t("settingsPage.exp.recommended", { v }) : v,
              ck: minLimit === v ? "✓" : "",
            }))}
            onPick={(v) => updateAcp({ minContextLimit: v })}
          />
        </div>

        {/* 3. Forced compaction threshold (hard reminder) */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.hardTitle")}</b>
            <span>{t("settingsPage.exp.hardDesc")}</span>
          </div>
          <Sel
            label={maxLimit}
            disabled={!enabled}
            options={MAX_LIMIT_OPTIONS.map((v) => ({
              v,
              label: v === "55%" ? t("settingsPage.exp.recommended", { v }) : v,
              ck: maxLimit === v ? "✓" : "",
            }))}
            onPick={(v) => updateAcp({ maxContextLimit: v })}
          />
        </div>

        {/* 4. Context window size override */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.ctxWinTitle")}</b>
            <span>{t("settingsPage.exp.ctxWinDesc")}</span>
          </div>
          <div className="srow-ctl">
            <input
              className={"inp" + (enabled ? "" : " disabled")}
              style={{ width: 170 }}
              placeholder={t("settingsPage.exp.ctxWinPlaceholder")}
              value={cwInput}
              disabled={!enabled}
              onChange={(e) => setCwInput(e.target.value)}
              onBlur={() => {
                if (cwInput.trim() !== (acpConfig?.contextWindow || "")) {
                  updateAcp({ contextWindow: cwInput.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>

        {/* 5. Candidate range suggestions */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.candidatesTitle")}</b>
            <span>{t("settingsPage.exp.candidatesDesc")}</span>
          </div>
          <div
            className={"tg" + (candidates ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ candidates: !candidates });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 6. Protect user prompts */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.protectTitle")}</b>
            <span>{t("settingsPage.exp.protectDesc")}</span>
          </div>
          <div
            className={"tg" + (protectUser ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ protectUserMessages: !protectUser });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 7. Anti-repetition in system prompt */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.sysPromptTitle")}</b>
            <span>{t("settingsPage.exp.sysPromptDesc")}</span>
          </div>
          <div
            className={"tg" + (sysPrompt ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ systemPrompt: !sysPrompt });
            }}
          >
            <i></i>
          </div>
        </div>
      </div>

      {/* Section 2: sessions & retrieval */}
      <div className="set-group-tt">{t("settingsPage.exp.sessionGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.exp.sessionGroupDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              {t("settingsPage.exp.sessionTitle")}
              <span className="srow-wn-inline">{t("settingsPage.exp.restartCacheWarn")}</span>
            </b>
            <span>{t("settingsPage.exp.sessionDesc")}</span>
          </div>
          <div
            className={"tg" + (ctxEnabled ? " on" : "") + (ctxKnown ? "" : " disabled")}
            id="tgSessionContext"
            onClick={() => send({ type: "set_session_context_enabled", enabled: !ctxEnabled })}
          >
            <i></i>
          </div>
        </div>
      </div>

      {/* Section 3: cache keepalive */}
      <div className="set-group-tt">{t("settingsPage.exp.kaGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.exp.kaGroupDesc")}</div>
      <div className="set-card">
        {/* 1. Master switch: whether this app loads the extension */}
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              {t("settingsPage.exp.kaTitle")}
              <span className="srow-wn-inline">{t("settingsPage.exp.kaWarn")}</span>
            </b>
            <span>{t("settingsPage.exp.kaDesc")}</span>
          </div>
          <div
            className={"tg" + (kaEnabled ? " on" : "") + (kaKnown ? "" : " disabled")}
            id="tgKeepalive"
            onClick={() => send({ type: "set_keepalive_enabled", enabled: !kaEnabled })}
          >
            <i></i>
          </div>
        </div>

        {/* 2. Keepalive models (multi-select; empty = probe no models) */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaModelsTitle")}</b>
            <span>{t("settingsPage.exp.kaModelsDesc")}</span>
            {kaTargets.length > 0 && (
              <div className="ka-targets">
                {kaTargets.map((id) => {
                  const m = modelCatalog.find((x) => x.id === id);
                  return (
                    <span
                      key={id}
                      className="ka-target"
                      title={t("settingsPage.exp.removeTarget")}
                      onClick={() => {
                        if (!kaEnabled) return;
                        updateKa({ targets: kaTargets.filter((t) => t !== id) });
                      }}
                    >
                      {m ? m.name : id}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <EnabledModelPicker
            label={t("settingsPage.exp.addModel")}
            // Same pool as the composer model menu (modelNames = host-enabled chat
            // models): synthetic providers (local/web) and non-chat kinds never list here
            exclude={kaTargets}
            disabled={!kaEnabled || [...modelNames.keys()].every((id) => kaTargets.includes(id))}
            onPick={(id) => updateKa({ targets: [...kaTargets, id] })}
          />
        </div>

        {/* 3. Probe mode */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaModeTitle")}</b>
            <span>{t("settingsPage.exp.kaModeDesc")}</span>
          </div>
          <Sel
            label={kaMode === "smart" ? t("settingsPage.exp.kaModeSmart") : t("settingsPage.exp.kaModeFixed")}
            disabled={!kaEnabled}
            options={[
              { v: "default", label: t("settingsPage.exp.kaModeFixed"), ck: kaMode === "default" ? "✓" : "" },
              { v: "smart", label: t("settingsPage.exp.kaModeSmart"), ck: kaMode === "smart" ? "✓" : "" },
            ]}
            onPick={(v) => updateKa({ mode: v })}
          />
        </div>

        {/* 4. Probe cadence (effective in fixed mode; smart self-manages) */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaIntervalTitle")}</b>
            <span>{t("settingsPage.exp.kaIntervalDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? fmtDur(kaConfig.intervalMs) : ""}
            placeholder="8m"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ intervalMs: v })}
          />
        </div>

        {/* 5. Idle stop deadline */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaIdleTitle")}</b>
            <span>{t("settingsPage.exp.kaIdleDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? (kaConfig.maxIdleMs === 0 ? "0" : fmtDur(kaConfig.maxIdleMs)) : ""}
            placeholder="1h"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxIdleMs: v })}
          />
        </div>

        {/* 6. Pause after consecutive misses */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaMissTitle")}</b>
            <span>{t("settingsPage.exp.kaMissDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxMissStreak) : ""}
            placeholder="1"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxMissStreak: v })}
          />
        </div>

        {/* 7. Circuit-break after consecutive failures */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaErrTitle")}</b>
            <span>{t("settingsPage.exp.kaErrDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxErrorStreak) : ""}
            placeholder="3"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxErrorStreak: v })}
          />
        </div>

        {/* 8. Per-session spend cap */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaSpendTitle")}</b>
            <span>{t("settingsPage.exp.kaSpendDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? (kaConfig.spendCapUsd === null ? "0" : String(kaConfig.spendCapUsd)) : ""}
            placeholder="1.0"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ spendCapUsd: v })}
          />
        </div>

        {/* 9. Minimum prompt tokens */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaMinPromptTitle")}</b>
            <span>{t("settingsPage.exp.kaMinPromptDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.minPromptTokens) : ""}
            placeholder="512"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ minPromptTokens: v })}
          />
        </div>

        {/* 10. Probe output cap */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaOutputTitle")}</b>
            <span>{t("settingsPage.exp.kaOutputDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxOutputTokens) : ""}
            placeholder="16"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxOutputTokens: v })}
          />
        </div>

        {/* 11. Context-ring center counter (UI pref, default on; independent of the master switch) */}
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaRingTitle")}</b>
            <span>{t("settingsPage.exp.kaRingDesc")}</span>
          </div>
          <div
            className={"tg" + (ringCount !== false ? " on" : "")}
            onClick={() => {
              useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, ctxRingProbeCount: ringCount === false } }));
              saveUiPrefs();
            }}
          >
            <i></i>
          </div>
        </div>
      </div>
    </div>
  );
}