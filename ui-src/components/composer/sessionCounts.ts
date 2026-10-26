// Session-derived counts for the composer bottom bar (moved out of
// components/Composer.tsx by A14): running background commands and running
// subagents. Pure functions over the open-session snapshot.

import type { BgJobEntry } from "../../store/session";

/** Structural subset of a session tool row (bgTaskCount reads only these fields;
 *  see the store for the full shape) */
type BgToolItem = {
  role?: string;
  name?: string;
  text?: string;
  args?: { op?: string; name?: string; application?: string };
  running?: boolean;
  details?: { async?: { state?: string } };
};

// Running background command count (ported from the runningCount part of the old
// right.js getBgTasksForSession: only iterates top-level s.items -- tools wrapped
// in loop groups no longer count; hub start counts in, stop/cancel offsets the
// same-named process)
//
// Auto-backgrounded commands (bash/eval tool rows finished with "Backgrounded as
// job ...") count through two sources: the bg_jobs snapshot (`bgJobs`, authoritative
// once the host has pushed it — a finished job drops out of `running`), falling
// back to the transcript rows' details.async.state before the first snapshot lands.
export function bgTaskCount(s: { items?: BgToolItem[] } | null | undefined, bgJobs?: BgJobEntry[] | null) {
  if (!s) return 0;
  // `task` jobs are subagent spawns, not background commands: they already have their own
  // counter pill (subagents), so counting them here would double-count in the same bar.
  const asyncJobs = bgJobs ? bgJobs.filter((j) => j.running && j.type !== "task").length : null;
  let n = 0;
  const live = new Set<string>();
  let asyncRows = 0;
  for (const it of s.items ?? []) {
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const proc = args.name || args.application || "";
      // Only count background processes by pairing start/stop/cancel. Do not fall
      // back to it.running: that means "hub tool executing" (between the tool and
      // tool_update frames); list/status hit it equally, it is not liveness
      if (op === "start") {
        n++;
        if (proc) live.add(proc);
      } else if ((op === "stop" || op === "cancel") && proc && live.has(proc)) {
        n--;
        live.delete(proc);
      }
    } else if (name === "bash" || name === "shell" || name === "eval") {
      if (it.running) {
        n++; // foreground execution in flight (tool frame arrived, tool_update not yet)
      } else if (it.details?.async?.state === "running") {
        asyncRows++; // backgrounded and alive; replaced by the snapshot once it arrives
      }
    }
  }
  return Math.max(0, n + (asyncJobs ?? asyncRows));
}

// Running subagent count (ported from the old right.js getRunningSubagentCount)
export function subagentCount(s: { subagents?: Map<string, { streaming?: boolean; status?: string }> } | null | undefined) {
  if (!s?.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}
