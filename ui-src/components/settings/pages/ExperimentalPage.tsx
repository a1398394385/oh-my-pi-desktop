// Settings page: experimental features (pg-experimental).
// Section 1: ACP context compaction (master switch + tier-mode switch + L1/L2/L3 threshold inputs)
// Section 2: project-shared terminal tabs (experimental pref)
// Section 3: sessions & retrieval (past-session retrieval read_session_context)
// Section 4: cache warming (desktop port of pi-kimi-keepalive, master switch + configurable
// probe parameters; omp-desktop.json lives independently per profile)
// Styling language matches the appearance page: set-page / set-tt / set-group-tt / set-group-desc / set-card / .srow / .tg / .sel / .inp.
import { useEffect, useState } from "react";
import { saveUiPrefs } from "../../../appearance";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import { EnabledModelPicker } from "../../ModelPicker";
import { Toggle, Sel } from "../common";
import type { AcpConfig } from "../../../types/frames";
import {
  listDevices,
  startAudioCapture,
  stopAudioCapture,
  writeAudioPref,
  type AudioDevice,
} from "../../chat/railAudio";

const TIER_DEFAULTS_K = ["150", "250", "350"]; // placeholder lines when a tier value is unconfigured

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
  suffix,
  decimalLimit,
  onSubmit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  /** Unit label rendered after the input (tier rows: K / %) */
  suffix?: string;
  /** Max fractional digits allowed while typing (tier rows: 1); omit for no filtering */
  decimalLimit?: number;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  // decimalLimit set: keep digits and at most one dot with that many fractional digits; unset: no filtering (legacy keepalive rows keep free text).
  const filter = (s: string): string => {
    if (decimalLimit === undefined) return s;
    const m = s.replace(/[^\d.]/g, "").match(/^(\d*)(?:\.(\d*))?/);
    const int = m?.[1] ?? "";
    const frac = (m?.[2] ?? "").slice(0, decimalLimit);
    return frac ? `${int}.${frac}` : int + (s.includes(".") && int ? "." : "");
  };
  return (
    <div className="srow-ctl">
      <input
        className={"inp" + (disabled ? " disabled" : "")}
        style={{ width: suffix ? 120 : 170 }}
        placeholder={placeholder}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(filter(e.target.value))}
        onBlur={() => {
          if (v.trim() !== value) onSubmit(v.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {suffix ? <span className="text-faint">{suffix}</span> : null}
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
  const arKnown = typeof hostSettings?.autoReviewOfferMode === "boolean";
  const arEnabled = arKnown && !!hostSettings?.autoReviewOfferMode;
  const trKnown = typeof hostSettings?.sessionTitleRefresh === "boolean";
  const trEnabled = trKnown && !!hostSettings?.sessionTitleRefresh;
  const kaKnown = typeof hostSettings?.keepaliveEnabled === "boolean";
  const kaEnabled = kaKnown && !!hostSettings?.keepaliveEnabled;
  const kaConfig = hostSettings?.keepaliveConfig;
  const kaMode = kaConfig?.mode ?? "default";
  const kaTargets = kaConfig?.targets ?? [];
  const ringCount = useAppStore((s) => s.uiPrefs.ctxRingProbeCount);
  const modelNames = useAppStore((s) => s.modelNames);
  const modelCatalog = useAppStore((s) => s.modelCatalog); // chip display names (covers disabled picked targets too)

  // Message-rail music reactivity: Windows-only (the Rust capture module is
  // `#![cfg(windows)]`). Platform comes from the shared UA probe in
  // ui-src/platform.ts — the shell exposes no os API, so window.__TAURI__.os is
  // undefined and would disable the switch on every platform.
  // Prefs are read through selectors (not a plain getState call) so the switch
  // and device row re-render the moment a write lands.
  const railMusic = useAppStore((s) => s.uiPrefs.railMusic === true);
  const sharedTerm = useAppStore((s) => s.uiPrefs.terminalShared === true);
  const railMusicDevice = useAppStore((s) => s.uiPrefs.railMusicDevice ?? "");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    void listDevices().then(setDevices);
  }, []);

  const acpConfig = hostSettings?.acpConfig;
  const tierMode = acpConfig?.tierMode ?? "absolute";
  // Tier rows: absolute mode displays/edits K tokens (×1000 on write); percent mode stores the percentage as-is.
  const commitTier = (key: "l1" | "l2" | "l3", raw: string) => {
    const n = Number(raw);
    // Invalid edits don't write; the push-back refresh on the next settings frame restores the true value.
    if (!raw || !Number.isFinite(n) || n < 0) return;
    updateAcp({ [key]: tierMode === "percent" ? n : Math.round(n * 1000) });
  };
  // Protected-tail rows: tailTurns edits whole turns; tailTokens edits K tokens (×1000 on write).
  const commitTail = (key: "tailTurns" | "tailTokens", raw: string) => {
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n < 0) return;
    updateAcp({ [key]: key === "tailTurns" ? Math.round(n) : Math.round(n * 1000) });
  };

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
          <Toggle on={enabled} disabled={!known} onChange={() => updateAcp({ enabled: !enabled })} />
        </div>

        {/* Detail rows live only while the feature is on (inline expand-down, .exp-rows) */}
        {enabled && (
          <div className="exp-rows">
            {/* 2. Threshold mode: absolute token lines vs percentages of the model window */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.tierModeTitle")}</b>
                <span>{t("settingsPage.exp.tierModeDesc")}</span>
              </div>
              <div className="mcp-type-pills">
                {(["absolute", "percent"] as const).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={"mcp-type-pill" + (tierMode === m ? " on" : "")}
                    onClick={() => {
                      if (tierMode === m) return;
                      // Mode switch re-interprets the stored numbers (tokens vs percent);
                      // null out the tier lines so the new mode starts from defaults.
                      send({ type: "set_acp_config", config: { tierMode: m, l1: null, l2: null, l3: null } });
                    }}
                  >
                    {t(m === "absolute" ? "settingsPage.exp.tierModeAbsolute" : "settingsPage.exp.tierModePercent")}
                  </button>
                ))}
              </div>
            </div>

            {/* 3..5. L1/L2/L3 tier lines */}
            {(["l1", "l2", "l3"] as const).map((key, i) => {
              const stored = acpConfig?.[key];
              return (
                <div className="srow" key={key}>
                  <div className="srow-tx">
                    <b>{t("settingsPage.exp.tierTitle", { tier: i + 1 })}</b>
                    <span>{t("settingsPage.exp.tierDesc")}</span>
                  </div>
                  <KaInput
                    value={stored === undefined ? "" : String(Math.round((tierMode === "percent" ? stored : stored / 1000) * 10) / 10)}
                    placeholder={tierMode === "percent" ? "" : TIER_DEFAULTS_K[i]}
                    suffix={tierMode === "percent" ? "%" : "K"}
                    decimalLimit={1}
                    onSubmit={(raw) => commitTier(key, raw)}
                  />
                </div>
              );
            })}
            {/* 6..7. Protected tail: recent turns / tokens exempt from compression */}
            {(["tailTurns", "tailTokens"] as const).map((key) => (
              <div className="srow" key={key}>
                <div className="srow-tx">
                  <b>{t(`settingsPage.exp.${key}Title`)}</b>
                  <span>{t(`settingsPage.exp.${key}Desc`)}</span>
                </div>
                <KaInput
                  value={acpConfig?.[key] === undefined ? "" : String(key === "tailTurns" ? acpConfig[key] : Math.round((acpConfig[key] / 1000) * 10) / 10)}
                  placeholder={key === "tailTurns" ? "2" : "20"}
                  suffix={key === "tailTurns" ? "turn" : "K"}
                  decimalLimit={key === "tailTurns" ? 0 : 1}
                  onSubmit={(raw) => commitTail(key, raw)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 2: project-shared terminals (experimental) */}
      <div className="set-group-tt">{t("settingsPage.exp.terminalGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.exp.terminalGroupDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">{t("settingsPage.exp.sharedTerminalTitle")}</b>
            <span>{t("settingsPage.exp.sharedTerminalDesc")}</span>
          </div>
          <Toggle
            on={sharedTerm}
            onChange={() => {
              useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, terminalShared: !sharedTerm } }));
              saveUiPrefs();
            }}
          />
        </div>
      </div>

      {/* Section 3: sessions & retrieval */}
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
          <Toggle
            on={ctxEnabled}
            disabled={!ctxKnown}
            onChange={() => send({ type: "set_session_context_enabled", enabled: !ctxEnabled })}
          />
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">{t("settingsPage.exp.autoReviewTitle")}</b>
            <span>{t("settingsPage.exp.autoReviewDesc")}</span>
          </div>
          <Toggle on={arEnabled} disabled={!arKnown} onChange={() => send({ type: "set_auto_review", offer: !arEnabled })} />
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">{t("settingsPage.exp.titleRefreshTitle")}</b>
            <span>{t("settingsPage.exp.titleRefreshDesc")}</span>
          </div>
          <Toggle on={trEnabled} disabled={!trKnown} onChange={() => send({ type: "set_session_title_refresh", enabled: !trEnabled })} />
        </div>
      </div>

      {/* Section 4: cache keepalive */}
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
          <Toggle
            on={kaEnabled}
            disabled={!kaKnown}
            onChange={() => send({ type: "set_keepalive_enabled", enabled: !kaEnabled })}
          />
        </div>

        {/* Detail rows live only while the feature is on (inline expand-down, .exp-rows) */}
        {kaEnabled && (
          <div className="exp-rows">
            {/* 2. Keepalive models (multi-select; empty = probe no models) */}
            <div className="srow">
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
                          onClick={() => updateKa({ targets: kaTargets.filter((t) => t !== id) })}
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
                disabled={[...modelNames.keys()].every((id) => kaTargets.includes(id))}
                onPick={(id) => updateKa({ targets: [...kaTargets, id] })}
              />
            </div>

            {/* 3. Probe mode */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaModeTitle")}</b>
                <span>{t("settingsPage.exp.kaModeDesc")}</span>
              </div>
              <Sel
                label={kaMode === "smart" ? t("settingsPage.exp.kaModeSmart") : t("settingsPage.exp.kaModeFixed")}
                options={[
                  { v: "default", label: t("settingsPage.exp.kaModeFixed"), ck: kaMode === "default" ? "✓" : "" },
                  { v: "smart", label: t("settingsPage.exp.kaModeSmart"), ck: kaMode === "smart" ? "✓" : "" },
                ]}
                onPick={(v) => updateKa({ mode: v })}
              />
            </div>

            {/* 4. Probe while a permission approval is waiting */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaApprovalTitle")}</b>
                <span>{t("settingsPage.exp.kaApprovalDesc")}</span>
              </div>
              <Toggle
                on={!!kaConfig?.probeDuringApproval}
                onChange={() => updateKa({ probeDuringApproval: !kaConfig?.probeDuringApproval })}
              />
            </div>

            {/* 5. Probe while an ask card is waiting */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaAskTitle")}</b>
                <span>{t("settingsPage.exp.kaAskDesc")}</span>
              </div>
              <Toggle on={!!kaConfig?.probeDuringAsk} onChange={() => updateKa({ probeDuringAsk: !kaConfig?.probeDuringAsk })} />
            </div>

            {/* 6. Farewell probes after the session was read */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaReadWarmTitle")}</b>
                <span>{t("settingsPage.exp.kaReadWarmDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? String(kaConfig.readWarmups) : ""}
                placeholder="1"
                onSubmit={(v) => updateKa({ readWarmups: v })}
              />
            </div>

            {/* 7. Probe cadence (effective in fixed mode; smart self-manages) */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaIntervalTitle")}</b>
                <span>{t("settingsPage.exp.kaIntervalDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? fmtDur(kaConfig.intervalMs) : ""}
                placeholder="8m"
                onSubmit={(v) => updateKa({ intervalMs: v })}
              />
            </div>

            {/* 8. Idle stop deadline */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaIdleTitle")}</b>
                <span>{t("settingsPage.exp.kaIdleDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? (kaConfig.maxIdleMs === 0 ? "0" : fmtDur(kaConfig.maxIdleMs)) : ""}
                placeholder="1h"
                onSubmit={(v) => updateKa({ maxIdleMs: v })}
              />
            </div>

            {/* 9. Pause after consecutive misses */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaMissTitle")}</b>
                <span>{t("settingsPage.exp.kaMissDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? String(kaConfig.maxMissStreak) : ""}
                placeholder="1"
                onSubmit={(v) => updateKa({ maxMissStreak: v })}
              />
            </div>

            {/* 10. Circuit-break after consecutive failures */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaErrTitle")}</b>
                <span>{t("settingsPage.exp.kaErrDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? String(kaConfig.maxErrorStreak) : ""}
                placeholder="3"
                onSubmit={(v) => updateKa({ maxErrorStreak: v })}
              />
            </div>

            {/* 11. Per-session spend cap */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaSpendTitle")}</b>
                <span>{t("settingsPage.exp.kaSpendDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? (kaConfig.spendCapUsd === null ? "0" : String(kaConfig.spendCapUsd)) : ""}
                placeholder="1.0"
                onSubmit={(v) => updateKa({ spendCapUsd: v })}
              />
            </div>

            {/* 12. Minimum prompt tokens */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaMinPromptTitle")}</b>
                <span>{t("settingsPage.exp.kaMinPromptDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? String(kaConfig.minPromptTokens) : ""}
                placeholder="512"
                onSubmit={(v) => updateKa({ minPromptTokens: v })}
              />
            </div>

            {/* 13. Probe output cap */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaOutputTitle")}</b>
                <span>{t("settingsPage.exp.kaOutputDesc")}</span>
              </div>
              <KaInput
                value={kaConfig ? String(kaConfig.maxOutputTokens) : ""}
                placeholder="16"
                onSubmit={(v) => updateKa({ maxOutputTokens: v })}
              />
            </div>

            {/* 14. Context-ring center counter (UI pref, default on; the counter only
                exists while the keep-alive probes run) */}
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.exp.kaRingTitle")}</b>
                <span>{t("settingsPage.exp.kaRingDesc")}</span>
              </div>
              <Toggle
                on={ringCount !== false}
                onChange={() => {
                  useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, ctxRingProbeCount: ringCount === false } }));
                  saveUiPrefs();
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Section 5: message-rail music reactivity (WASAPI loopback on Windows,
          ScreenCaptureKit on macOS) */}
      <div className="set-group-tt">{t("settingsPage.exp.railMusicGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.exp.railMusicGroupDesc")}</div>
      <div className="set-card">
        {/* 1. Master switch */}
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">{t("settingsPage.exp.railMusicTitle")}</b>
            <span>{t("settingsPage.exp.railMusicDesc")}</span>
          </div>
          <Toggle
            on={railMusic}
            onChange={() => {
              const next = !railMusic;
              writeAudioPref(next, railMusicDevice);
              void (next ? startAudioCapture(railMusicDevice) : stopAudioCapture());
            }}
          />
        </div>

        {/* 2. Capture device (empty id = system default output; on macOS the
            capture always follows the system default, so the list has one entry) */}
        <div className={"srow" + (railMusic ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.railDeviceTitle")}</b>
            <span>{t("settingsPage.exp.railDeviceDesc")}</span>
          </div>
          <Sel
            label={devices.find((d) => d.id === railMusicDevice)?.name ?? t("settingsPage.exp.railDeviceDefault")}
            disabled={!railMusic}
            dropUp
            wide
            options={[
              { v: "", label: t("settingsPage.exp.railDeviceDefault"), ck: railMusicDevice === "" ? "✓" : "" },
              ...devices.map((d) => ({
                v: d.id,
                label: d.name,
                ck: railMusicDevice === d.id ? "✓" : "",
              })),
            ]}
            onPick={(v) => {
              writeAudioPref(true, v);
              void startAudioCapture(v); // restart on the newly picked endpoint
            }}
          />
        </div>
      </div>
    </div>
  );
}