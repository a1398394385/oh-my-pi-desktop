// Subagent transcript: the "submsg" right tab renders one child agent's transcript read-only
// while the middle column keeps the user's active session. The session is loaded through
// loadSessionInBackground (the session_created frame skips activation for it), so this page
// only projects the already-landed items.
import { useEffect, useMemo } from "react";
import { useAppStore, loadSessionInBackground } from "../../../store";
import { renderItems } from "../../chat/items";
import type { RailEntry } from "../../chat/chat-types";

export default function SubagentTranscriptPage() {
  const path = useAppStore((st) => st.subagentView);
  const s = useAppStore((st) => (path ? st.openSessions.get(path) : undefined));
  // The entry can be evicted (openSessions cap) while the tab stays open: reload in the
  // background, the transcript reappears when session_created lands.
  useEffect(() => {
    if (path && !s) loadSessionInBackground(path);
  }, [path, s]);
  // Rail entries are the message-page side channel (ticks per message); a bare transcript
  // has no rail, but renderItems fills the array as a traversal side effect, so it still
  // needs a real one.
  const nodes = useMemo(() => {
    if (!s) return null;
    const entries: RailEntry[] = [];
    return { list: renderItems(s.items ?? [], "sub-", entries, undefined, { live: !!s.streaming }), entries };
  }, [s]); // sessions are replaced immutably on every frame, so `s` covers items/streaming
  if (!path || !nodes) return <div className="rb-scroll" />;
  return <div className="rb-scroll sub-msg-stream">{nodes.list}</div>;
}
