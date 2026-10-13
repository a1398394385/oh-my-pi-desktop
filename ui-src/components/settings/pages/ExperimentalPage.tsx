// Settings page: experimental features (pg-experimental).
// Section 1: ACP context compaction (master switch + tier-mode switch + L1/L2/L3 threshold inputs)
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
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";
import type { AcpConfig } from "../../../types/frames";
import {
  listDevices,
  startAudioCapture,
  stopAudioCapture,
  writeAudioPref,
  type AudioDevice,
} from "../../chat/railAudio";

const TIER_DEFAULTS_K = ["100", "200", "300"]; // placeholder lines when a tier value is unconfigured

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
  dropUp,
  wide,
}: {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
  disabled?: boolean;
  /** Open the menu upward (used when the row sits where a dropdown would clip the viewport). */
  dropUp?: boolean;
  /** Wider menu for option labels that overflow the 170px base (device names). */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      releaseDropdown(close);
    };
  }, [open]);

  const cls = "sel" + (disabled ? " disabled" : "") + (dropUp ? " sel-up" : "") + (wide ? " sel-wide" : "");
  return (
    <div
      className={cls}
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

        {/* 2. Threshold mode: absolute token lines vs percentages of the model window */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
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
                  if (!enabled || tierMode === m) return;
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
            <div className={"srow" + (enabled ? "" : " disabled")} key={key}>
              <div className="srow-tx">
                <b>{t("settingsPage.exp.tierTitle", { tier: i + 1 })}</b>
                <span>{t("settingsPage.exp.tierDesc")}</span>
              </div>
              <KaInput
                value={stored === undefined ? "" : String(Math.round((tierMode === "percent" ? stored : stored / 1000) * 10) / 10)}
                placeholder={tierMode === "percent" ? "" : TIER_DEFAULTS_K[i]}
                suffix={tierMode === "percent" ? "%" : "K"}
                disabled={!enabled}
                decimalLimit={1}
                onSubmit={(raw) => commitTier(key, raw)}
              />
            </div>
          );
        })}
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

        {/* 4. Probe while a permission approval is waiting */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaApprovalTitle")}</b>
            <span>{t("settingsPage.exp.kaApprovalDesc")}</span>
          </div>
          <div
            className={"tg" + (kaConfig?.probeDuringApproval ? " on" : "")}
            onClick={() => {
              if (!kaEnabled) return;
              updateKa({ probeDuringApproval: !kaConfig?.probeDuringApproval });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 5. Probe while an ask card is waiting */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaAskTitle")}</b>
            <span>{t("settingsPage.exp.kaAskDesc")}</span>
          </div>
          <div
            className={"tg" + (kaConfig?.probeDuringAsk ? " on" : "")}
            onClick={() => {
              if (!kaEnabled) return;
              updateKa({ probeDuringAsk: !kaConfig?.probeDuringAsk });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 6. Farewell probes after the session was read */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.exp.kaReadWarmTitle")}</b>
            <span>{t("settingsPage.exp.kaReadWarmDesc")}</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.readWarmups) : ""}
            placeholder="1"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ readWarmups: v })}
          />
        </div>

        {/* 7. Probe cadence (effective in fixed mode; smart self-manages) */}
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

        {/* 8. Idle stop deadline */}
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

        {/* 9. Pause after consecutive misses */}
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

        {/* 10. Circuit-break after consecutive failures */}
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

        {/* 11. Per-session spend cap */}
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

        {/* 12. Minimum prompt tokens */}
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

        {/* 13. Probe output cap */}
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

        {/* 14. Context-ring center counter (UI pref, default on; independent of the master switch) */}
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

      {/* Section 4: message-rail music reactivity (WASAPI loopback on Windows,
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
          <div
            className={"tg" + (railMusic ? " on" : "")}
            id="tgRailMusic"
            onClick={() => {
              const next = !railMusic;
              writeAudioPref(next, railMusicDevice);
              void (next ? startAudioCapture(railMusicDevice) : stopAudioCapture());
            }}
          >
            <i></i>
          </div>
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