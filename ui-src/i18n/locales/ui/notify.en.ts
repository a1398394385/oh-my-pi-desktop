// en counterpart of notify.zh.ts — keep keys in sync.
export const notifyEn = {
  // WS connection status (store/ws.ts)
  connecting: "Connecting…",
  noHost: "No host",
  hostStartFailed: "Host failed to start: {{error}}",
  connected: "Connected",
  disconnected: "Disconnected",
  // Working-state text (store/session.ts)
  working: "Working…",
  thinking: "Thinking…",
  thinkingLabel: "Thinking",
  thinkingDone: "Thinking · {{label}}",
  thinkingTookSeconds: "took a few seconds",
  waiting: "Waiting for background work or a peer…",
  // Desktop notifications (store/session.ts, store/wsHandlers/stream.ts)
  approvalTitle: "Awaiting approval",
  bgSessionTitle: "Background session",
  finished: "Finished",
  // Session lifecycle toasts (store/wsHandlers/session.ts)
  renamed: "Renamed",
  renameFailed: "Rename failed",
  archived: "Archived",
  unarchived: "Unarchived",
  archiveFailed: "Archive failed",
  generationStopped: "Generation stopped",
  contextCompacted: "Context compacted",
  compactFailed: "Compaction failed",
  forkFailed: "Fork failed",
  forked: "Forked to a new session",
  navigateFailed: "Navigation failed",
  navigated: "Navigated to the selected node",
  // Git operation toasts (store/wsHandlers/files.ts)
  changesDiscarded: "Changes discarded",
  gitOpFailed: "git operation failed",
  committed: "Committed {{sha}}",
  commitFailed: "Commit failed",
  pushed: "Pushed",
  pushFailed: "Push failed",
  branchSwitched: "Switched to branch {{branch}}",
  // Settings / config toasts (store/wsHandlers/settings.ts, config.ts)
  savedRestartHint: "Saved. Restart the app for some network settings to take full effect",
  profileActivated: "Profile activated: {{profile}}",
  loginProgress: "{{provider}}: {{message}}",
  loginOk: "{{provider}} signed in, model list refreshed",
  loginCancelled: "Sign-in cancelled",
  loginFailed: "{{provider}} sign-in failed: {{message}}",
  apiKeySaved: "{{provider}} API key saved, model list refreshed",
  configPath: "Config file: {{path}}",
  wizardSaved: "{{provider}} saved ({{count}} models) to models.yml",
  wizardModelSaved: "{{model}} metadata saved to models.yml",
  skillDeleted: "Skill deleted",
  fileDeleted: "File deleted",
  mcpConnected: "MCP [{{name}}] connected",
  mcpProbeFailed: "MCP [{{name}}] probe failed: {{error}}",
  // Duration formatting (store/utils.ts)
  durationSec: "{{n}}s",
  durationMinSec: "{{n}}m {{m}}s",
  durationHourMin: "{{n}}h {{m}}m",
};

export default notifyEn;
