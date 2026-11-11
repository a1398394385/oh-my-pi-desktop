// Resume model substitution notice (BUG-125 residue): the model this session was
// saved with no longer resolves (a retired id or dropped credentials), so the host
// resumed the transcript on another one. One dismissible strip above the message
// area, in the connection banner's visual language. Closing it pins the from+to
// pair on the session — pure local UI state, remote clients never send a write RPC.
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store";
import { updateSession } from "../../store/session";
import Icon from "../../Icon";

export default function ModelFallbackNotice() {
  const { t } = useTranslation();
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const fb = session?.modelFallback;
  if (!session || !fb) return null;
  // Same pair, same key: a re-push on switch-back never re-opens a closed notice
  const key = `${fb.from}\n${fb.to}`;
  if (session.modelFallbackDismissed === key) return null;
  return (
    <div className="conn-banner" role="status">
      <Icon name="shieldWarn" size={14} />
      <span className="conn-banner-text">{t("notify.modelFallbackNotice", { from: fb.from, to: fb.to })}</span>
      <span className="sp" />
      <button
        className="icon-btn"
        title={t("notify.modelFallbackDismiss")}
        aria-label={t("notify.modelFallbackDismiss")}
        onClick={() => updateSession(session.sessionId, (s) => { s.modelFallbackDismissed = key; }, false)}
      >
        ×
      </button>
    </div>
  );
}
