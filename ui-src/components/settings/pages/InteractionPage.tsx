// Settings page: interaction (pg-interaction). Schema rows cover the agent-side groups; the
// desktop alerts section below is app-level (uiPrefs) and drives the Rust shell's system
// notification + alert sound, including the macOS notification-authorization row.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, toast } from "../../../store";
import { invoke } from "../../../store/ws";
import { saveUiPrefs } from "../../../appearance";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

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
    <div className="srow set-row">
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
      <div className="set-group-tt">{t("settingsPage.alerts.group")}</div>
      <div className="set-group-desc">{t("settingsPage.alerts.groupDesc")}</div>
      <div className="set-card">
        <div className="srow set-row">
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
        <div className="srow set-row">
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
  return (
    <div className="set-page" id="pg-interaction">
      <div className="set-tt">{t("settingsPage.nav.interaction")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-interaction"]} />
      <DesktopAlertsSection />
    </div>
  );
}
