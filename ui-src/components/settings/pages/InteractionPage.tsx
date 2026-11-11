// Settings page: interaction (pg-interaction). Schema rows cover the agent-side groups; the
// desktop alerts section is app-level (uiPrefs) and drives the Rust shell's system
// notification + alert sound, including the macOS notification-authorization row. The
// session-behavior rows (ask timeout / title refresh / auto-archive) moved here from the
// general page.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import { invoke } from "../../../store/ws";
import { saveUiPrefs } from "../../../appearance";
import SchemaRows, { SchemaGroupTitle, SchemaRowsBare } from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { Sel, Srow, Toggle } from "../common";

/** Play the alert sound once so the user hears what the toggle does (no-op outside Tauri). */
function previewSound(): void {
  invoke?.("play_alert_sound")?.catch((err: unknown) => console.warn("play_alert_sound:", err));
}

/**
 * macOS notification authorization: the system-notification toggle is useless without it, so the
 * state and its request / System Settings entry sit right below that toggle. Hidden outside Tauri
 * and on platforms without an authorization model (the command answers "unsupported" — Windows
 * notifications need no grant). Re-queried on window focus, so a grant made in System Settings
 * shows up on return.
 */
function NotificationPermissionRow() {
  const { t } = useTranslation();
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const inv = invoke;
    if (!inv) return;
    const refresh = () => {
      inv("notification_permission_status")
        .then((s) => setState(String(s)))
        .catch((err: unknown) => console.warn("notification_permission_status:", err));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  if (!invoke || state === null || state === "unsupported") return null;

  const inv = invoke;
  const granted = state === "authorized" || state === "provisional";
  const request = () => {
    setBusy(true);
    inv("request_notification_permission")
      .then((s) => setState(String(s)))
      .catch((err: unknown) => toast(t("settingsPage.alerts.permFailed", { error: String(err) })))
      .finally(() => setBusy(false));
  };
  const openSettings = () => {
    inv("open_permission_setting", { panel: "notifications" }).catch((err: unknown) =>
      toast(t("settingsPage.alerts.permFailed", { error: String(err) })),
    );
  };
  const desc = granted
    ? t("settingsPage.alerts.permGrantedDesc")
    : state === "notDetermined"
      ? t("settingsPage.alerts.permAskDesc")
      : state === "denied"
        ? t("settingsPage.alerts.permDeniedDesc")
        : state === "unavailable"
          ? t("settingsPage.alerts.permUnavailableDesc")
          : t("settingsPage.alerts.permUnknownDesc");

  return (
    <div className="srow set-row" data-key="app.notifyPermission">
      <div className="srow-tx">
        <b>{t("settingsPage.alerts.permTitle")}</b>
        <span>{desc}</span>
      </div>
      <div className="srow-ctl">
        {granted ? (
          <span className="save-btn perm-ok">{t("settingsPage.alerts.permGranted")}</span>
        ) : state === "notDetermined" ? (
          <button className="save-btn" disabled={busy} onClick={request}>
            {busy ? t("settingsPage.alerts.permRequesting") : t("settingsPage.alerts.permRequest")}
          </button>
        ) : state === "denied" ? (
          <button className="save-btn" onClick={openSettings}>
            {t("settingsPage.alerts.permOpen")}
          </button>
        ) : (
          <span className="save-btn">{t("settingsPage.alerts.permUnavailable")}</span>
        )}
      </div>
    </div>
  );
}

// The host "Notifications" section (placement renders it like any other group)
// plus the app-level alert rows below — one heading, one rounded card. Defined
// here so both the heading/rows pair and the placement filter use one constant;
// buildKeyToPageMap keeps reading the full PAGE_PLACEMENT, so settings-search
// page mapping is unaffected by the filter.
const NOTIFY_SECTION = { from: "interaction/Notifications", excludeKeys: ["ask.timeout"] };

// Ask timeout (omp ask.timeout): the base schema files it under the
// Notifications group, but the desktop renders it by hand (free seconds input
// + save) instead of the preset-value dropdown, so it is excluded from the
// schema rows of that group and drawn here.
function AskTimeoutRow() {
  const { t } = useTranslation();
  const value = useAppStore((s) => s.hostSettings?.values?.["ask.timeout"]);
  const [text, setText] = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText(value != null ? String(value) : "");
  }, [value]);
  return (
    <Srow title={t("settingsPage.interaction.askTimeoutTitle")} desc={t("settingsPage.interaction.askTimeoutDesc")} dataKey="ask.timeout">
      <input
        className="inp"
        style={{ width: 100, minWidth: 0 }}
        type="number"
        min="0"
        step="1"
        placeholder="0"
        value={text}
        ref={inputRef}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="save-btn"
        onClick={() => {
          const raw = parseFloat(text);
          const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
          send({ type: "set_setting", key: "ask.timeout", value: secs });
        }}
      >
        {t("common.save")}
      </button>
    </Srow>
  );
}

// Session-behavior rows moved here from the general page: title refresh
// (host/titles.ts) and auto-archive (host/auto-archive.ts). Both are app-level
// settings the host reports in the settings frame, not schema rows.
function SessionBehaviorSections() {
  const { t } = useTranslation();
  const hs = useAppStore((s) => s.hostSettings);
  const titleRefreshKnown = typeof hs?.sessionTitleRefresh === "boolean";
  const titleRefreshEnabled = titleRefreshKnown && !!hs?.sessionTitleRefresh;
  const titleRefreshPrompts = hs?.sessionTitleRefreshPrompts ?? 1;
  const titleRefreshOptions = hs?.sessionTitleRefreshOptions?.length ? hs.sessionTitleRefreshOptions : [1, 3, 5, 10];
  const btKnown = typeof hs?.branchTitles === "boolean";
  const btEnabled = btKnown && !!hs?.branchTitles;
  const archiveKnown = typeof hs?.autoArchiveEnabled === "boolean";
  const archiveEnabled = archiveKnown && !!hs?.autoArchiveEnabled;
  const retentionDays = hs?.autoArchiveRetentionDays ?? 14;
  const retentionOptions = hs?.autoArchiveRetentionOptions?.length ? hs.autoArchiveRetentionOptions : [7, 14, 30, 90];
  return (
    <>
      <div className="set-group-tt">{t("settingsPage.interaction.groupTitleRefresh")}</div>
      <div className="set-card">
        <Srow
          title={t("settingsPage.interaction.titleRefreshTitle")}
          desc={t("settingsPage.interaction.titleRefreshDesc")}
          dataKey="app.titleRefresh"
        >
          <Toggle
            on={titleRefreshEnabled}
            disabled={!titleRefreshKnown}
            onChange={() => send({ type: "set_session_title_refresh", enabled: !titleRefreshEnabled })}
          />
        </Srow>
        <Srow
          title={t("settingsPage.interaction.titleRefreshEveryTitle")}
          desc={t("settingsPage.interaction.titleRefreshEveryDesc")}
          dataKey="app.titleRefreshEvery"
        >
          <Sel
            label={t("settingsPage.interaction.titleRefreshEveryN", { n: titleRefreshPrompts })}
            value={String(titleRefreshPrompts)}
            options={titleRefreshOptions.map((n) => ({
              v: String(n),
              label: t("settingsPage.interaction.titleRefreshEveryN", { n }),
              ck: n === titleRefreshPrompts ? "✓" : "",
            }))}
            onPick={(v) => send({ type: "set_session_title_refresh", prompts: Number(v) })}
          />
        </Srow>
        <Srow
          title={t("settingsPage.interaction.branchTitlesTitle")}
          desc={t("settingsPage.interaction.branchTitlesDesc")}
          dataKey="app.branchTitles"
        >
          <Toggle
            on={btEnabled}
            disabled={!btKnown}
            onChange={() => send({ type: "set_branch_titles", enabled: !btEnabled })}
          />
        </Srow>
      </div>
      <div className="set-group-tt">{t("settingsPage.interaction.groupArchive")}</div>
      <div className="set-card">
        <Srow
          title={t("settingsPage.interaction.archiveAutoTitle")}
          desc={t("settingsPage.interaction.archiveAutoDesc")}
          dataKey="app.autoArchive"
        >
          <Toggle
            on={archiveEnabled}
            disabled={!archiveKnown}
            onChange={() => send({ type: "set_auto_archive", enabled: !archiveEnabled })}
          />
        </Srow>
        <Srow
          title={t("settingsPage.interaction.archiveRetentionTitle")}
          desc={t("settingsPage.interaction.archiveRetentionDesc")}
          dataKey="app.autoArchiveRetention"
        >
          <Sel
            label={t("settingsPage.interaction.archiveRetentionDays", { days: retentionDays })}
            value={String(retentionDays)}
            options={retentionOptions.map((d) => ({
              v: String(d),
              label: t("settingsPage.interaction.archiveRetentionDays", { days: d }),
              ck: d === retentionDays ? "✓" : "",
            }))}
            onPick={(v) => send({ type: "set_auto_archive", retentionDays: Number(v) })}
          />
        </Srow>
      </div>
    </>
  );
}

function DesktopAlertsSection() {
  const { t } = useTranslation();
  const prefs = useAppStore((s) => s.uiPrefs);
  const desktopOn = prefs.notifyDesktop !== false;
  const soundOn = prefs.notifySound !== false;
  const write = (patch: { notifyDesktop?: boolean; notifySound?: boolean }) => {
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, ...patch } }));
    saveUiPrefs();
  };
  return (
    <>
      <SchemaGroupTitle sections={[NOTIFY_SECTION]} />
      <div className="set-card">
        <SchemaRowsBare sections={[NOTIFY_SECTION]} />
        <AskTimeoutRow />
        <div className="srow set-row" data-key="app.notifyDesktop">
          <div className="srow-tx">
            <b>{t("settingsPage.alerts.desktopTitle")}</b>
            <span>{t("settingsPage.alerts.desktopDesc")}</span>
          </div>
          <div className="srow-ctl">
            <div className={"tg" + (desktopOn ? " on" : "")} onClick={() => write({ notifyDesktop: !desktopOn })}>
              <i></i>
            </div>
          </div>
        </div>
        <NotificationPermissionRow />
        <div className="srow set-row" data-key="app.notifySound">
          <div className="srow-tx">
            <b>{t("settingsPage.alerts.soundTitle")}</b>
            <span>{t("settingsPage.alerts.soundDesc")}</span>
          </div>
          <div className="srow-ctl">
            <div
              className={"tg" + (soundOn ? " on" : "")}
              onClick={() => {
                const next = !soundOn;
                write({ notifySound: next });
                if (next) previewSound();
              }}
            >
              <i></i>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function InteractionPage() {
  const { t } = useTranslation();
  // The merged Notifications card renders at the section's original placement
  // (after Approvals), so the remaining groups split around it instead of the
  // merged card drifting to the page bottom.
  const all = PAGE_PLACEMENT["pg-interaction"];
  const notifyIdx = all.findIndex((s) => s.from === NOTIFY_SECTION.from);
  const before = notifyIdx >= 0 ? all.slice(0, notifyIdx) : all;
  const after = notifyIdx >= 0 ? all.slice(notifyIdx + 1) : [];
  return (
    <div className="set-page" id="pg-interaction">
      <div className="set-tt">{t("settingsPage.nav.interaction")}</div>
      <SchemaRows sections={before} />
      <DesktopAlertsSection />
      <SchemaRows sections={after} />
      <SessionBehaviorSections />
    </div>
  );
}
