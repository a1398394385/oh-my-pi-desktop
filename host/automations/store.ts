// Automations persistence: <agentDir>/automations.json, read fresh on every
// call (profile hot-switch repoints H.agentDir and the next read follows; no
// cached path). Tolerance model mirrors host/desktop-json.ts: missing or
// corrupt file reads back as the empty state; writes are tmp+rename so a crash
// mid-write cannot leave a half-file behind.
import fs from "node:fs";
import path from "node:path";
import { H } from "../state.ts";
import { RUNS_PER_AUTOMATION_KEEP } from "./types.ts";
import type { Automation, AutomationRun, AutomationsFile } from "./types.ts";

/** Read the automations document (missing/corrupt file -> empty state). */
export function readAutomations(): AutomationsFile {
  try {
    // Host-written file: trust the outer shape, fall back per section.
    const parsed = JSON.parse(fs.readFileSync(path.join(H.agentDir, "automations.json"), "utf8")) as Partial<AutomationsFile> | null;
    const automations = Array.isArray(parsed?.automations)
      ? parsed.automations.filter((a): a is Automation => !!a && typeof a === "object" && "id" in a)
      : [];
    const runs: Record<string, AutomationRun[]> = {};
    if (parsed?.runs && typeof parsed.runs === "object") {
      for (const [id, list] of Object.entries(parsed.runs)) {
        if (Array.isArray(list)) runs[id] = list.filter((r): r is AutomationRun => !!r && typeof r === "object" && "runId" in r);
      }
    }
    return { automations, runs };
  } catch {
    return { automations: [], runs: {} };
  }
}

/** Atomically persist the automations document (tmp file + rename in the same directory). */
export function writeAutomations(state: AutomationsFile): void {
  const file = path.join(H.agentDir, "automations.json");
  // A smoke/test profile may write before anything else touched the agent dir.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Keep only the RUNS_PER_AUTOMATION_KEEP most recent runs of one automation.
 * Mutates runs[automationId] in place (newest first by createdAt); no-op when
 * the automation has no run history. Call after every run append, before writeAutomations.
 */
export function trimRuns(runs: Record<string, AutomationRun[]>, automationId: string): void {
  const list = runs[automationId];
  if (!Array.isArray(list)) return;
  list.sort((left, right) => right.createdAt - left.createdAt);
  if (list.length > RUNS_PER_AUTOMATION_KEEP) list.length = RUNS_PER_AUTOMATION_KEEP;
}
