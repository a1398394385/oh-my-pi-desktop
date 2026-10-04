// Assistant message: markdown rendering goes through the shared MdSurface component (P6
// streamdown engine + the .md-surface TUI-parity semantics); the .md-* classes re-attached by
// MdSurface keep the .md-body rules in style.css hitting. The streaming variant (streaming
// tail) additionally carries the streaming-draft class.
//
// Performance red line (2026-09-21 freeze incident): React.memo must stay here —
// a delta-frame-induced full-tree re-render would rerun the markdown parsing pipeline for
// every historical message; in long sessions the main thread gets saturated by 10-per-second
// full reparses and the app appears dead (the compositor thread keeps animating).
// With memo, historical messages with unchanged props are skipped outright; only the one
// still streaming re-parses.
import { memo } from "react";
import MdSurface from "./MdSurface";

// Strip ACP <dcp-message-id> tags: the host strips them from persisted text before pushing
// frames, but tag fragments during streaming text_delta reach rendering directly (the host
// cannot reliably split tags across deltas); this is the fallback cleanup.
// Same pattern as REF_TAG_RE in host/acp-context.ts.
const DCP_TAG_RE = /<dcp-message-id>m\d{1,5}<\/dcp-message-id>\n?/g;
function stripDcpTags(s: string): string {
  const out = s.replace(DCP_TAG_RE, "");
  return out === s ? s : out.trim();
}

function AssistantMsgImpl({ text, fk, streaming }: { text?: string; fk?: string; streaming?: boolean }) {
  const plain = text ? stripDcpTags(text) : text;
  return (
    <MdSurface
      text={plain || ""}
      className={"msg assistant md-body md-surface" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={plain ? undefined : { display: "none" }}
    />
  );
}

export default memo(AssistantMsgImpl);
