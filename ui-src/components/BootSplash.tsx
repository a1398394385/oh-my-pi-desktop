// Boot splash: full-window veil shown from launch until the first session_list
// frame lands (WS connect + host boot). It covers the welcome page's brief "/"
// placeholder window and the host's >15s cold start; the skip link drops into
// the shell early — the project reconciliation in wsHandlers/session.ts still
// swaps the placeholder once data arrives.
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { t } from "../i18n";
import Icon from "../Icon";

export default function BootSplash() {
  const bootSplash = useAppStore((s) => s.bootSplash);
  const connText = useAppStore((s) => s.connText);
  // Unmount only after the fade-out budget elapses (bootSplash=false starts it)
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (bootSplash) return;
    const timer = setTimeout(() => setGone(true), 220);
    return () => clearTimeout(timer);
  }, [bootSplash]);
  if (gone) return null;
  return (
    <div id="bootSplash" className={bootSplash ? "" : "out"}>
      <span className="bs-logo"><Icon name="logo" size={52} /></span>
      <div className="bs-status">
        <span className="bs-spin" aria-hidden="true"></span>
        <span>{connText || t("misc.bootConnecting")}</span>
      </div>
      <button type="button" className="save-btn bs-skip" onClick={() => useAppStore.setState({ bootSplash: false })}>
        {t("misc.skipBoot")}
      </button>
    </div>
  );
}
