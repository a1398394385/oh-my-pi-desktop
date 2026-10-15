import { useTranslation } from "react-i18next";
import { LiveProvider } from "../stats/data/live";
import { StatsShell } from "../stats/StatsShell";

export default function StatsPage() {
  const { t } = useTranslation();

  return (
    <div className="set-page" id="pg-stats">
      <div className="set-tt">
        {t("settingsPage.nav.stats")} <span className="stag on">omp stats</span>
      </div>
      <LiveProvider>
        <StatsShell />
      </LiveProvider>
    </div>
  );
}
