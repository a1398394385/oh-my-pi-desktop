// Connection watchdog banner: when host connection failures persist past a threshold, show an
// actionable recovery surface at the top of the main area
// (cf. PI-Desktop #850's startup watchdog — turning "silently never reaching the host" into
// "retryable, diagnosable").
// The automatic retry loop (ws.ts scheduleReconnect) keeps running; the banner neither
// interrupts nor replaces it: it disappears once connected.
// Quit/close uses the window's own controls (traffic lights/title bar), not duplicated here.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../store";

// Threshold of 30s: covers the host cold-start worst path (model catalog refresh over a proxy
// can take >15s), while staying ahead of the Rust side's 60s ws_url timeout — users should
// see an actionable hint between the two
const SHOW_AFTER_MS = 30_000;

export default function ConnBanner() {
  const { t } = useTranslation();
  const connected = useAppStore((s) => s.connected);
  const connText = useAppStore((s) => s.connText);
  const connFailSince = useAppStore((s) => s.connFailSince);
  const [now, setNow] = useState(Date.now());

  // Refresh once per second while failing (drives the "waited Ns" text and threshold check);
  // no timer while connected
  useEffect(() => {
    if (connected || connFailSince == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connected, connFailSince]);

  if (connected || connFailSince == null) return null;
  const waited = now - connFailSince;
  if (waited < SHOW_AFTER_MS) return null;

  const copyDiagnostics = () => {
    const report = [
      t("misc.connDiagTitle"),
      t("misc.connDiagWait", { sec: Math.round(waited / 1000) }),
      t("misc.connDiagStatus", { text: connText }),
      t("misc.connDiagPlatform", { platform: navigator.platform }),
      `UA: ${navigator.userAgent}`,
      t("misc.connDiagTime", { time: new Date().toISOString() }),
    ].join("\n");
    void navigator.clipboard.writeText(report);
    useAppStore.getState().toast(t("misc.diagCopied"));
  };

  return (
    <div className="conn-banner" role="alert">
      <span className="conn-banner-text">
        {t("misc.connBanner", { text: connText, sec: Math.round(waited / 1000) })}
      </span>
      <span className="sp"></span>
      <button className="save-btn" onClick={() => void useAppStore.getState().connect()}>
        {t("misc.retryNow")}
      </button>
      <button className="save-btn" onClick={copyDiagnostics}>
        {t("misc.copyDiag")}
      </button>
    </div>
  );
}
