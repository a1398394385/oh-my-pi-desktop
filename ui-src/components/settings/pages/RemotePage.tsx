// Settings page: remote control (pg-remote, spec §4.6).
// Enable toggle + listen port + access key (masked, copy access link, regenerate) + service
// status. State SSOT: store.remoteConfig (remote_config / remote_key replies), seeded from the
// settings frame's remote segment until the first reply lands. Styling reuses the shared
// settings language only: set-page / set-tt / set-group-desc / set-card / .srow.set-row /
// .tg / .inp / .save-btn(.danger) / .srow-wn (settings/common.css + global/controls.css).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import { copyText, fmtAgo } from "../../main/sidebar/util";
import { Toggle, confirmDialog } from "../common";

export default function RemotePage() {
  const { t } = useTranslation();
  const hostRemote = useAppStore((s) => s.hostSettings?.remote);
  const cfg = useAppStore((s) => s.remoteConfig);
  // remote_config / remote_key replies win; the settings frame provides the initial pull
  const known = !!cfg || !!hostRemote;
  const enabled = cfg?.enabled ?? hostRemote?.enabled ?? false;
  const port = cfg?.port ?? hostRemote?.port ?? 0;
  const error = cfg?.error ?? undefined;
  const key = cfg?.key ?? hostRemote?.key ?? "";
  const url = cfg?.url ?? hostRemote?.url ?? "";
  // Device history only rides the settings frame (remote_config replies stay config-only)
  const devices = hostRemote?.devices ?? [];
  // Phone display preference: only the settings frame carries it (the remote_config reply
  // stays enabled/port/error), so it reads through hostRemote alone. Default off.
  const mobileStatsBar = hostRemote?.mobileStatsBar === true;

  // Port draft: follows the authoritative value until the user edits it (same push-back
  // pattern as the keepalive rows' KaInput)
  const [portDraft, setPortDraft] = useState(String(port || ""));
  useEffect(() => setPortDraft(String(port || "")), [port]);
  const savePort = () => {
    const n = parseInt(portDraft, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535 || n === port) {
      setPortDraft(String(port || "")); // invalid or unchanged: push the authoritative value back
      return;
    }
    send({ type: "set_remote_config", port: n });
  };

  const copyLink = () => {
    if (!url) return;
    // WKWebView rejects clipboard.writeText without user activation; copyText has the execCommand fallback
    void copyText(url).then(() =>
      useAppStore.getState().toast(t("settingsPage.remote.keyCopied")),
    );
  };

  const regenerate = async () => {
    if (
      await confirmDialog({
        title: t("settingsPage.remote.keyRegenConfirm"),
        message: t("settingsPage.remote.keyRegenMsg"),
        confirmText: t("settingsPage.remote.keyRegen"),
        danger: true,
      })
    ) {
      send({ type: "remote_regenerate_key" });
    }
  };

  return (
    <div className="set-page" id="pg-remote">
      <div className="set-tt">{t("settingsPage.nav.remote")}</div>
      <div className="set-group-desc">{t("settingsPage.remote.groupDesc")}</div>
      <div className="set-card">
        {/* 1. Master switch */}
        <div className="srow set-row">
          <div className="srow-tx">
            <b>{t("settingsPage.remote.enabledTitle")}</b>
            <span>{t("settingsPage.remote.enabledDesc")}</span>
          </div>
          <Toggle
            on={enabled}
            disabled={!known}
            onChange={() => send({ type: "set_remote_config", enabled: !enabled })}
          />
        </div>

        {/* 2. Listen port (numeric input + explicit save) */}
        <div className={"srow set-row" + (known ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.remote.portTitle")}</b>
            <span>{t("settingsPage.remote.portDesc")}</span>
          </div>
          <div className="srow-ctl">
            <input
              className="inp"
              style={{ width: 90 }}
              inputMode="numeric"
              value={portDraft}
              disabled={!known}
              onChange={(e) => setPortDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
              onKeyDown={(e) => {
                if (e.key === "Enter") savePort();
              }}
            />
            <button type="button" className="save-btn" disabled={!known} onClick={savePort}>
              {t("settingsPage.remote.portSave")}
            </button>
          </div>
        </div>

        {/* 3. Access key: masked display + copy full access link + regenerate (danger) */}
        <div className={"srow set-row" + (known ? "" : " disabled")}>
          <div className="srow-tx">
            <b>{t("settingsPage.remote.keyTitle")}</b>
            <span>{t("settingsPage.remote.keyDesc")}</span>
            {key ? <code>{key.slice(0, 6)}…{key.slice(-4)}</code> : null}
          </div>
          <div className="srow-ctl">
            <button type="button" className="save-btn" disabled={!url} title={url || undefined} onClick={copyLink}>
              {t("settingsPage.remote.keyCopy")}
            </button>
            <button type="button" className="save-btn danger" disabled={!known} onClick={regenerate}>
              {t("settingsPage.remote.keyRegen")}
            </button>
          </div>
        </div>

        {/* 4. Device history: every visitor that passed the key check, newest first */}
        <div className="srow set-row">
          <div className="srow-tx">
            <b>{t("settingsPage.remote.devicesTitle")}</b>
            <span>{t("settingsPage.remote.devicesDesc")}</span>
          </div>
          <div className="srow-ctl remote-devices">
            {devices.length === 0 ? (
              <span className="text-faint">{t("settingsPage.remote.devicesEmpty")}</span>
            ) : (
              devices.map((d) => (
                <div key={`${d.name} ${d.ip}`} className="remote-device">
                  <span>{d.name}</span>
                  <span className="text-faint">
                    {d.ip} · {fmtAgo(new Date(d.lastAt).toISOString())}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 5. Phone stats bar: narrow clients hide the session stats bar under the composer
            unless this is on (the switch is a client display preference, not server state) */}
        <div className="srow set-row">
          <div className="srow-tx">
            <b>{t("settingsPage.remote.mobileStatsBarTitle")}</b>
            <span>{t("settingsPage.remote.mobileStatsBarDesc")}</span>
          </div>
          <Toggle
            on={mobileStatsBar}
            disabled={!known}
            onChange={() => send({ type: "set_remote_config", mobileStatsBar: !mobileStatsBar })}
          />
        </div>

        {/* 6. Service status: listening / disabled, or the last start-rebind error */}
        <div className="srow set-row">
          <div className="srow-tx">
            <b>{t("settingsPage.remote.statusTitle")}</b>
            {error ? <span className="srow-wn">{error}</span> : <span>{t("settingsPage.remote.statusDesc")}</span>}
          </div>
          <div className="srow-ctl">
            <span className="text-faint">
              {!known
                ? t("settingsPage.remote.statusUnknown")
                : error
                  ? t("settingsPage.remote.statusError")
                  : enabled
                    ? t("settingsPage.remote.statusListening")
                    : t("settingsPage.remote.statusStopped")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
