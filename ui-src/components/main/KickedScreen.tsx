// Full-page remote-takeover screen (Spec §4.1): a kicked remote client replaces the whole
// page with this card instead of showing an in-page banner — the app underneath holds stale
// data and every page (list / chat / panel) must be blocked. No auto-reconnect happens
// underneath (a retry loop would fight the new holder); the button clears the kicked gate and
// reconnects manually, kicking whoever holds the host now.
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store";
import Icon from "../../Icon";

export default function KickedScreen() {
  const { t } = useTranslation();
  return (
    <div id="kicked-screen" role="alertdialog" aria-modal="true">
      <div className="kicked-card">
        <div className="kicked-head">
          <span className="kicked-ic"><Icon name="toastErr" size={18} /></span>
          <span className="kicked-badge">{t("notify.kickedBadge")}</span>
        </div>
        <div className="kicked-title">{t("notify.kickedTitle")}</div>
        <p className="kicked-desc">{t("notify.kickedBody")}</p>
        <div className="kicked-sep"></div>
        <div className="kicked-next">{t("notify.kickedNext")}</div>
        <ol className="kicked-steps">
          <li><span className="kicked-num">1</span><span>{t("notify.kickedStep1")}</span></li>
          <li><span className="kicked-num">2</span><span>{t("notify.kickedStep2")}</span></li>
        </ol>
        <div className="kicked-status">
          <span>{t("notify.kickedRelay")}</span>
          <span className="kicked-code">{t("notify.kickedCode")}</span>
        </div>
        <button
          className="kicked-btn"
          onClick={() => {
            useAppStore.setState({ kickedByOther: false });
            void useAppStore.getState().connect();
          }}
        >
          {t("notify.kickedReclaim")}
        </button>
      </div>
    </div>
  );
}
