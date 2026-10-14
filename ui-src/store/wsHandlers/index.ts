// Aggregated frame-handler table: five domains merged. Exhaustiveness is cross-asserted via key
// unions (TS skips missing-key checks on object spreads, so a HandlerMap annotation alone can't
// catch missed frames): every HostFrame member must appear in some domain key set; when Missing is
// not never, AssertNever fails at compile time — equivalent to the old switch's default-never.
// Unknown runtime frames (host from a newer version) look up to undefined, preserving the old
// default's silent-ignore semantics. The guard (stamped-event dedupe) lives at the dispatch entry
// in store/ws.ts; domain handlers only do business landing.
import { configHandlers, type ConfigFrames } from "./config";
import { sessionHandlers, type SessionFrames } from "./session";
import { streamHandlers, type StreamFrames } from "./stream";
import { filesHandlers, type FilesFrames } from "./files";
import { settingsHandlers, type SettingsFrames } from "./settings";
import { automationsHandlers, type AutomationsFrames } from "./automations";
import { btwHandlers, type BtwFrames } from "./btw";
import type { HandlerMap, IgnoredFrames } from "./types";
import type { HostFrame } from "../../types/frames";

// Exhaustiveness assertion: when a frame type is missed, Missing narrows to that literal and the AssertNever constraint fails.
// IgnoredFrames (session_tree) is excluded on purpose: the host still serves the cross-file
// branch-family query (smoke-branch.ts probes it), but the UI has no consumer since the
// right-panel branch tree was removed.
type Covered = ConfigFrames | SessionFrames | StreamFrames | FilesFrames | SettingsFrames | AutomationsFrames | BtwFrames;
type Missing = Exclude<HostFrame["type"], Covered | IgnoredFrames>;
type AssertNever<T extends never> = T;
type _allFramesCovered = AssertNever<Missing>;

export const frameHandlers: HandlerMap = {
  ...configHandlers,
  ...sessionHandlers,
  ...streamHandlers,
  ...filesHandlers,
  ...settingsHandlers,
  ...automationsHandlers,
  ...btwHandlers,
};

/** Single-frame dispatch: table-driven (unknown runtime frames silently ignored, same fallback as the old switch default) */
export function dispatchFrame(msg: HostFrame): void {
  const h = (frameHandlers as Partial<Record<string, (m: HostFrame) => void>>)[msg.type];
  h?.(msg);
}
