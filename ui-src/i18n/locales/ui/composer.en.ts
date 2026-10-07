// en counterpart of composer.zh.ts — keep keys in sync.
export const composerEn = {
  // Composer.tsx
  placeholder: "Ask anything, @ to mention, / for commands",
  addContext: "Add context",
  permissionMode: "Permission mode",
  planOnTitle: "Plan mode is on, click to exit",
  planLabel: "Plan",
  computerOnTitle: "Computer use is on, click to turn off",
  computerOffTitle: "Computer use is off, click to turn on",
  bgCommands: "Background commands",
  subagents: "Subagents",
  switchModel: "Switch model",
  thinkLevel: "Thinking level",
  sendEscAgain: "Press Esc again to interrupt",
  stopCommand: "Stop command",
  stopGeneration: "Stop generation",
  sendQueued: "Send (queued, dispatched after the current task)",
  send: "Send",
  modelFallback: "Model",
  thinkFallback: "Thinking",
  needSession: "Create or open a session first",
  oversizeFile: "\"{{name}}\" exceeds 10MB, not added",
  readFail: "Failed to read \"{{name}}\"",
  imageN: "Image {{n}}",
  // ModeMenu.tsx
  modeAlwaysAsk: "Manual approval",
  modeWrite: "Default",
  modeYolo: "Full auto",
  modeAlwaysAskDesc: "Ask before operations that need approval",
  modeWriteDesc: "Run routine operations automatically, ask for key decisions",
  modeYoloDesc: "Run everything without confirmation",
  planMode: "Plan mode",
  planModeDesc: "Research read-only and produce a plan, then code after approval",
  planModeHint: "Plan read-only first, execute after the plan is approved",
  // ModelMenu.tsx
  noModels: "No models configured",
  modelRoleCategory: "Model Role",
  onlyOneRoleModel: "Only one role model available",
  // ThinkMenu.tsx
  reasoning: "Reasoning level",
  // QueueCard.tsx
  queuedHint: "Queued: sent automatically when the current task finishes",
  noText: "(no text)",
  sendNow: "Send now (inject after the current step)",
  editQueued: "Edit (back to composer)",
  // AttachRow.tsx
  remove: "Remove",
  // GoalCard.tsx
  resumeGoal: "Resume goal (/goal resume)",
  pauseGoal: "Pause goal (/goal pause)",
  dropGoal: "Drop goal (/goal drop)",
  // PaletteMenu.tsx
  noMatch: "No match",
};

export default composerEn;
