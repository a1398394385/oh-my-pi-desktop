// Session-derived counts for the composer bottom bar (moved out of
// components/Composer.tsx by A14): running background commands and running
// subagents. Pure functions over the open-session snapshot.

/** Structural subset of a session tool row (bgTaskCount reads only these fields;
 *  see the store for the full shape) */
type BgToolItem = {
  role?: string;
  name?: string;
  text?: string;
  args?: { op?: string; name?: string; application?: string };
  running?: boolean;
};

// Running background command count (ported from the runningCount part of the old
// right.js getBgTasksForSession: only iterates top-level s.items -- tools wrapped
// in loop groups no longer count; hub start counts in, stop/cancel offsets the
// same-named process)
export function bgTaskCount(s: { items?: BgToolItem[] } | null | undefined) {
  if (!s) return 0;
  let n = 0;
  const live = new Set<string>();
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
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      n++;
    }
  }
  return Math.max(0, n);
}

// Running subagent count (ported from the old right.js getRunningSubagentCount)
export function subagentCount(s: { subagents?: Map<string, { streaming?: boolean; status?: string }> } | null | undefined) {
  if (!s?.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}
