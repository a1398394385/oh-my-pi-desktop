// Base UI-only notices (xd:// mount hints, tool-side warnings) as one strip above the
// composer stack. The store holds the newest notice per session and expires it on its own
// (ui-src/store/session.ts), so this component only renders what is there.
import { useAppStore } from "../../store";
import Icon from "../../Icon";

export default function SessionNotice() {
  const n = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.notice : null));
  if (!n) return null;
  return (
    <div className={"notice-strip " + n.level} role="status">
      <Icon name={n.level === "info" ? "info" : "shieldWarn"} size={14} />
      <span className="notice-text">{n.message}</span>
    </div>
  );
}
