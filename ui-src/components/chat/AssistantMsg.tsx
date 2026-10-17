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
import { memo, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";
import { motionEnabled } from "../../shell";
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

// Streaming reveal (TUI's streaming-reveal.ts counterpart): the store's 100ms applyDelta
// window lands text in whole bursts, which pop in at once. This walks the visible length
// toward the target at 30fps, advancing enough per tick to swallow any burst within
// REVEAL_CATCHUP_TICKS — so the tail never trails the true draft. Cost is bounded: the
// interval only exists while behind, and streamdown memoizes every completed block, so
// each tick re-parses the same trailing block the burst would have re-parsed anyway.
const REVEAL_TICK_MS = 33;
const REVEAL_CATCHUP_TICKS = 6;

function useReveal(target: string, on: boolean): string {
  // Seeded with the mount length: a history message (or a draft restored into a fresh
  // component) renders in full instead of replaying the reveal
  const shown = useRef(target.length);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) {
      shown.current = target.length;
      return;
    }
    // A fresh turn replaced the draft in place — snap, never animate backwards
    if (target.length < shown.current) {
      shown.current = target.length;
      bump((n) => n + 1);
      return;
    }
    if (target.length === shown.current) return;
    // Fixed step for the whole catch-up: a per-tick fraction of the remaining length decays
    // geometrically and never catches up on large bursts (3244 chars still trailed after
    // 900ms). Dividing the burst by the tick budget lands exactly on REVEAL_CATCHUP_TICKS.
    const step = Math.max(1, Math.ceil((target.length - shown.current) / REVEAL_CATCHUP_TICKS));
    const timer = setInterval(() => {
      shown.current = Math.min(target.length, shown.current + step);
      bump((n) => n + 1);
      if (shown.current >= target.length) clearInterval(timer);
    }, REVEAL_TICK_MS);
    return () => clearInterval(timer);
  }, [target, on]);
  return on ? target.slice(0, shown.current) : target;
}

function AssistantMsgImpl({ text, fk, streaming }: { text?: string; fk?: string; streaming?: boolean }) {
  const plain = text ? stripDcpTags(text) : text;
  // Subscribed so flipping the appearance motion switch applies to the live tail at once;
  // the gate itself reads the DOM (motionEnabled), this only supplies the re-render.
  useAppStore((s) => s.uiPrefs.motion);
  const shown = useReveal(plain || "", Boolean(streaming) && motionEnabled());
  return (
    <MdSurface
      text={shown}
      className={"msg assistant md-body md-surface" + (streaming ? " streaming-draft" : "")}
      data-fk={fk || undefined}
      style={plain ? undefined : { display: "none" }}
    />
  );
}

export default memo(AssistantMsgImpl);
