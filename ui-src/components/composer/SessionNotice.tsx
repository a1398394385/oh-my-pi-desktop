// Base UI-only notices (xd:// mount hints, tool-side warnings) as one strip in the
// below-dock slot, sharing the stats row's cell (composer.css). The store holds the newest
// notice per session and expires it on its own (ui-src/store/session.ts).
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";
import Icon from "../../Icon";

type Notice = { level: "info" | "warning" | "error"; message: string; seq: number };

export default function SessionNotice() {
  const n = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.notice : null));
  // The outgoing notice is kept one beat so the exit leg slides out with its text, not an
  // empty strip — same vertical carousel as the cache-miss flash (sbUpIn/sbUpOut).
  const [leaving, setLeaving] = useState<Notice | null>(null);
  const last = useRef<Notice | null>(null);
  useEffect(() => {
    if (n) {
      last.current = n;
      setLeaving(null);
      return;
    }
    if (!last.current) return;
    const gone = last.current;
    last.current = null;
    setLeaving(gone);
    const id = setTimeout(() => setLeaving(null), 320); // slightly past the 300ms slide
    return () => clearTimeout(id);
  }, [n]);
  const item = n ?? leaving;
  if (!item) return null;
  return (
    <div key={item.seq} className={"notice-strip " + item.level + (n ? " enter" : " exit")} role="status">
      <Icon name={item.level === "info" ? "info" : "shieldWarn"} size={14} />
      <span className="notice-text">{item.message}</span>
    </div>
  );
}
