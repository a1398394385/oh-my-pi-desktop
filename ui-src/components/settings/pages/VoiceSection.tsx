// Settings · Special-features page voice sections: speech output (system TTS
// + tts tool model) and dictation (local STT) blocks. Custom rows follow the
// canonical settings-card row language (.srow.set-row + .srow-tx + .srow-ctl)
// so the blocks read as native groups; the master-switch rows carry data-key
// so settings search still scrolls to them, and their switches use the shared
// Radix Switch (same control as every schema-rendered row). Speech output
// runs UI-side (lib/speechOut on the system speechSynthesis): the voice row's
// cascade picker merges the system voices into the catalog's "local" provider
// group alongside the tts-kind models (the tts/ask tool model, formerly its
// own "speech generation tool model" group). Dictation binds the base's
// dictation role (model picker via set_model_role, kind-filtered), gates its
// master switch on a cached model (voice_status + stt_download), and offers a
// hold-to-talk test whose result lands via stt_test_result.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { listTtsVoices, speakNow, setTtsVoicePref, getTtsVoicePref, setTtsDuck } from "../../../lib/speechOut";
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";
import { ModelCascadePicker, roleAcceptsModel } from "../RolePicker";
import { Switch } from "../../ui/switch";
import type { CatalogModel } from "../../ModelPicker";

// ---------- shared chrome ----------

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="set-group-tt">{title}</div>
      <div className="set-card">{children}</div>
    </>
  );
}

/** Dropdown pill on the settings-card row language (.sel), options inline. */
function Sel({ value, options, onPick, disabled }: { value: string | null; options: Array<{ value: string; label: string }>; onPick: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    const onDoc = (e: MouseEvent) => {
      if (!selRef.current?.contains(e.target as Node | null)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      releaseDropdown(close);
    };
  }, [open]);
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <div
      className={"sel" + (disabled ? " disabled" : "")}
      role="button"
      ref={selRef}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span>{current?.label ?? "—"}</span>
      <span className="caret-svg"><Icon name="caret" size={14} /></span>
      {open && (
        <div className="menu model open">
          {options.map((o) => (
            <div
              className={"mi" + (o.value === value ? " on" : "")}
              key={o.value}
              onClick={(e) => {
                e.stopPropagation();
                onPick(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Master-switch row: the data-key hook keeps settings-search scroll working;
 * the control is the shared Radix Switch used by every schema-rendered row. */
function SwitchRow({ settingKey, title, desc, on, disabled, disabledTip, onChange }: { settingKey: string; title: string; desc: string; on: boolean; disabled?: boolean; disabledTip?: string; onChange: (v: boolean) => void }) {
  return (
    <div className="srow set-row" data-key={settingKey}>
      <div className="srow-tx">
        <b>{title}</b>
        <span>{disabled && disabledTip ? disabledTip : desc}</span>
      </div>
      <div className="srow-ctl">
        <Switch checked={on} disabled={disabled} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

// ---------- speech output (system TTS + tts tool model) ----------

/** Pseudo-id prefix of the system-voice entries inside the merged voice picker;
 * the bare prefix itself is the "auto (follow UI language)" entry. */
const VOICE_PREFIX = "sys:";

export function VoiceTtsSection() {
  const { t } = useTranslation();
  const values = useAppStore((s) => s.hostSettings?.values) ?? {};
  const speechOn = values["speech.enabled"] === true;
  const mode = (values["speech.mode"] as string) ?? "assistant";
  const catalog = useAppStore((s) => s.modelCatalog);
  const modelRoles = useAppStore((s) => s.modelRoles);
  const speechRole = (modelRoles ?? []).find((r) => r.section === "kind" && r.id === "speech");
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [voicePref, setVoicePref] = useState(getTtsVoicePref());

  useEffect(() => {
    void listTtsVoices().then(setVoices);
  }, []);

  // Merged voice picker on the voice row: the system voices (what conversation
  // reading actually uses, UI-side speechSynthesis) lead the catalog's "local"
  // provider group — the same group as the bundled local TTS models — followed
  // by every tts-kind catalog model. This folds the former standalone "speech
  // generation tool model" role row into one picker: a local entry writes the
  // voice preference (and drops an explicit speech role, so the tts tool falls
  // back to the built-in local chain), a model entry writes the speech role.
  const pickerModels = [
    { id: VOICE_PREFIX, name: t("settingsPage.voice.autoVoice"), provider: "local" },
    ...voices.map((v) => ({ id: VOICE_PREFIX + v.name, name: `${v.name} (${v.lang})`, provider: "local" })),
    ...(speechRole ? catalog.filter((m) => roleAcceptsModel(speechRole, m)) : []).map((m) => ({ id: m.id, name: m.name, provider: m.provider })),
  ];
  const roleValue = speechRole?.value ?? null;
  const hit = voices.find((v) => v.name === voicePref);
  const label = roleValue
    ? (catalog.find((m) => m.id === roleValue)?.name ?? roleValue)
    : voicePref
      ? (hit ? `${hit.name} (${hit.lang})` : voicePref)
      : t("settingsPage.voice.autoVoice");

  return (
    <Group title={t("settingsPage.voice.ttsTitle")}>
      <div className="srow set-row">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.voiceRow")}</b>
          <span>{voices.length === 0 ? t("settingsPage.voice.noVoices") : t("settingsPage.voice.voiceRowDesc")}</span>
        </div>
        <div className="srow-ctl">
          <ModelCascadePicker
            models={pickerModels}
            label={label}
            selectedId={roleValue ?? VOICE_PREFIX + voicePref}
            onPick={(id) => {
              if (!id.startsWith(VOICE_PREFIX)) {
                send({ type: "set_model_role", role: "speech", value: id });
                return;
              }
              const v = id.slice(VOICE_PREFIX.length);
              setVoicePref(v);
              setTtsVoicePref(v);
              if (roleValue) send({ type: "set_model_role", role: "speech", value: null });
            }}
          />
        </div>
      </div>
      <SwitchRow
        settingKey="speech.enabled"
        title={t("settingsPage.voice.ttsSwitch")}
        desc={t("settingsPage.voice.ttsSwitchDesc")}
        on={speechOn}
        disabled={voices.length === 0}
        disabledTip={t("settingsPage.voice.noVoices")}
        onChange={(v) => send({ type: "set_setting", key: "speech.enabled", value: v })}
      />
      <div className="srow set-row">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.ttsMode")}</b>
          <span>{t("settingsPage.voice.ttsModeDesc")}</span>
        </div>
        <div className="srow-ctl">
          <Sel
            value={mode}
            options={[
              { value: "assistant", label: t("settingsPage.voice.modeAssistant") },
              { value: "all", label: t("settingsPage.voice.modeAll") },
              { value: "yield", label: t("settingsPage.voice.modeYield") },
            ]}
            onPick={(v) => send({ type: "set_setting", key: "speech.mode", value: v })}
          />
        </div>
      </div>
      <div className="srow set-row">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.ttsTest")}</b>
          <span>{t("settingsPage.voice.ttsTestDesc")}</span>
        </div>
        <div className="srow-ctl">
          <button
            type="button"
            className="save-btn"
            onClick={async () => {
              const ok = await speakNow(t("settingsPage.voice.ttsSample"));
              if (!ok) toast(t("settingsPage.voice.noVoices"));
            }}
          >
            <Icon name="play" size={14} />
            {t("settingsPage.voice.testBtn")}
          </button>
        </div>
      </div>
    </Group>
  );
}

// ---------- dictation (STT) ----------

export function VoiceSttSection() {
  const { t } = useTranslation();
  const values = useAppStore((s) => s.hostSettings?.values) ?? {};
  const sttOn = values["stt.enabled"] === true;
  const language = (values["stt.language"] as string) ?? "en";
  const submitTrigger = (values["stt.submitTrigger"] as string) ?? "never";
  const catalog = useAppStore((s) => s.modelCatalog);
  const modelRoles = useAppStore((s) => s.modelRoles);
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const download = useAppStore((s) => s.voiceDownload);
  const sttState = useAppStore((s) => s.voiceStt);
  const testResult = useAppStore((s) => s.sttTestResult);
  const [lang, setLang] = useState(language);
  const dictationRole = (modelRoles ?? []).find((r) => r.section === "kind" && r.id === "dictation");
  const sttModels: CatalogModel[] = catalog.filter((m) => m.kind === "stt");
  const modelId = voiceStatus?.modelId ?? null;
  const ready = voiceStatus?.ready === true;
  const downloading = voiceStatus?.downloading === true || (download !== null && Date.now() - download.at < 30_000 && download.percent < 100);

  // Refresh the snapshot on mount and after every model-role change
  useEffect(() => {
    send({ type: "voice_status" });
  }, [dictationRole?.value]);

  const modelOptions = [
    { value: "", label: t("settingsPage.voice.modelDefault", { model: modelId ?? "local/parakeet" }) },
    ...sttModels.map((m) => ({ value: m.id, label: m.name })),
  ];

  const testing = sttState?.state === "recording" || sttState?.state === "transcribing";

  return (
    <Group title={t("settingsPage.voice.sttTitle")}>
      <div className="srow set-row">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.sttModel")}</b>
          <span>
            {downloading
              ? t("settingsPage.voice.downloading", { percent: download?.percent ?? 0 })
              : modelId
                ? ready
                  ? t("settingsPage.voice.modelReady", { model: modelId })
                  : t("settingsPage.voice.modelNotReady", { model: modelId })
                : t("settingsPage.voice.sttModelDesc")}
          </span>
        </div>
        <div className="srow-ctl">
          <Sel
            value={dictationRole?.value ?? ""}
            options={modelOptions}
            onPick={(v) => send({ type: "set_model_role", role: "dictation", value: v || null })}
          />
          {!ready && !downloading ? (
            <button type="button" className="save-btn" onClick={() => send({ type: "stt_download" })}>
              <Icon name="refresh" size={14} />
              {t("settingsPage.voice.downloadBtn")}
            </button>
          ) : null}
        </div>
      </div>
      <SwitchRow
        settingKey="stt.enabled"
        title={t("settingsPage.voice.sttSwitch")}
        desc={t("settingsPage.voice.sttSwitchDesc")}
        on={sttOn}
        disabled={!ready}
        disabledTip={t("settingsPage.voice.sttGate", { model: modelId ?? "local/parakeet" })}
        onChange={(v) => send({ type: "set_setting", key: "stt.enabled", value: v })}
      />
      <div className="srow set-row" data-key="stt.language">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.languageRow")}</b>
          <span>{t("settingsPage.voice.languageRowDesc")}</span>
        </div>
        <div className="srow-ctl">
          <input
            className="inp voice-lang-inp"
            value={lang}
            placeholder="zh / en"
            onChange={(e) => setLang(e.target.value)}
            onBlur={() => {
              if (lang.trim() && lang.trim() !== language) send({ type: "set_setting", key: "stt.language", value: lang.trim() });
            }}
          />
        </div>
      </div>
      <div className="srow set-row" data-key="stt.submitTrigger">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.submitRow")}</b>
          <span>{t("settingsPage.voice.submitRowDesc")}</span>
        </div>
        <div className="srow-ctl">
          <Sel
            value={submitTrigger}
            options={[
              { value: "never", label: t("settingsPage.voice.submitNever") },
              { value: "release", label: t("settingsPage.voice.submitRelease") },
              { value: "release-complete", label: t("settingsPage.voice.submitReleaseComplete") },
              { value: "say-submit", label: t("settingsPage.voice.submitSay") },
            ]}
            onPick={(v) => send({ type: "set_setting", key: "stt.submitTrigger", value: v })}
          />
        </div>
      </div>
      <div className="srow set-row">
        <div className="srow-tx">
          <b>{t("settingsPage.voice.sttTest")}</b>
          <span>
            {testResult && Date.now() - testResult.at < 600_000
              ? t("settingsPage.voice.sttTestResult", { text: testResult.text || "…" })
              : t("settingsPage.voice.sttTestDesc")}
          </span>
        </div>
        <div className="srow-ctl">
          <button
            type="button"
            className={"save-btn voice-test-btn" + (testing ? " rec" : "")}
            disabled={!ready}
            onPointerDown={(e) => {
              if (e.button !== 0 || !ready) return;
              setTtsDuck(true);
              send({ type: "stt_start", sessionId: "voice-settings-test", anchor: "", test: true });
            }}
            onPointerUp={() => {
              setTtsDuck(false);
              send({ type: "stt_stop" });
            }}
            onPointerLeave={() => {
              setTtsDuck(false);
              send({ type: "stt_stop" });
            }}
          >
            <Icon name="mic" size={14} />
            {testing ? t("settingsPage.voice.sttTesting") : t("settingsPage.voice.testBtn")}
          </button>
        </div>
      </div>
    </Group>
  );
}
