// Agent Hub extension RPC senders (base 18.5 capability surface, contract v1): background
// jobs, subagent control (cancel/steer). Replies land through the canonical wsHandlers tables
// (bg_jobs → store bgJobs map; subagent_controlled failures toast from the handler); only the
// outbound requests live here so both hub surfaces (roster cards / subagent tab) share shapes.
import { useAppStore } from "../../../store";

export function sendGetBgJobs(sessionId: string): void {
  useAppStore.getState().send({ type: "get_bg_jobs", sessionId });
}

export function sendCancelBgJob(sessionId: string, jobId: string): void {
  useAppStore.getState().send({ type: "cancel_bg_job", sessionId, jobId });
}

export function sendSubagentControl(sessionId: string, agentId: string, action: "cancel" | "steer", text?: string): void {
  useAppStore.getState().send({ type: "control_subagent", sessionId, agentId, action, ...(text !== undefined ? { text } : {}) });
}
