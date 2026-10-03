import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatInteger } from "./data/formatters";
import { useLive } from "./data/live";
import { Dot } from "./ui";

const INDEXING_VISIBLE_HOURS = 24;

export function LiveChip() {
  const { t } = useTranslation();
  const { sync, indexingHours, connected, requestSync } = useLive();
  const now = useNow(sync.phase === "idle" ? 15_000 : null);

  const ago = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return t("settingsPage.stats.live.justNow");
    const m = Math.round(s / 60);
    if (m < 60) return t("settingsPage.stats.live.minutesAgo", { count: m });
    const h = Math.round(m / 60);
    if (h < 24) return t("settingsPage.stats.live.hoursAgo", { count: h });
    return t("settingsPage.stats.live.daysAgo", { count: Math.round(h / 24) });
  };

  let body: ReactNode;
  let title: string;
  if (!connected) {
    body = (
      <>
        <Dot tone="warn" />
        <span>{t("settingsPage.stats.live.reconnecting")}</span>
      </>
    );
    title = t("settingsPage.stats.live.reconnectingTitle");
  } else if (sync.phase === "syncing") {
    body = (
      <>
        <RefreshCw size={13} className="spin" />
        <span>{t("settingsPage.stats.live.syncing")}</span>
        {sync.total > 0 && (
          <span className="live-chip-count">
            {formatInteger(sync.current)}/{formatInteger(sync.total)}
          </span>
        )}
      </>
    );
    title = t("settingsPage.stats.live.syncingTitle");
  } else if (sync.phase === "error") {
    body = (
      <>
        <Dot tone="bad" />
        <span>{t("settingsPage.stats.live.syncFailed")}</span>
      </>
    );
    title = t("settingsPage.stats.live.syncFailedTitle", {
      message: sync.error ?? t("settingsPage.stats.live.syncFailed"),
    });
  } else if (indexingHours > INDEXING_VISIBLE_HOURS) {
    body = (
      <>
        <RefreshCw size={13} className="spin" />
        <span>{t("settingsPage.stats.live.indexing")}</span>
        <span className="live-chip-count">
          {t("settingsPage.stats.live.hoursLeft", { count: indexingHours })}
        </span>
      </>
    );
    title = t("settingsPage.stats.live.indexingTitle");
  } else {
    body = (
      <>
        <Dot tone="live" pulse />
        <span>{t("settingsPage.stats.live.live")}</span>
        {sync.lastSyncedAt !== null && <span className="live-chip-count">{ago(now - sync.lastSyncedAt)}</span>}
      </>
    );
    title = t("settingsPage.stats.live.liveTitle");
  }

  return (
    <button
      type="button"
      className="live-chip"
      onClick={requestSync}
      disabled={sync.phase === "syncing"}
      title={title}
    >
      {body}
    </button>
  );
}

function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
