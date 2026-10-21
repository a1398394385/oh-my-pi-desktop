// A10 wire contract, neutral ground between the host process (frame senders)
// and the UI (frame consumer). File map:
//   payloads.ts        -- shared payload shapes (TranscriptItem, UiEvent, settings/models views...)
//   frames-session.ts  -- session/git/bash/approval frame members
//   frames-models.ts   -- settings/models/login/assets/extensions/terminal/browser frame members
//   frames-live.ts     -- event-stream/subagent/voice/keepalive/ssh/automations/btw frame members
//   index.ts           -- this barrel + the HostFrame discriminated union
// Pure types only across the whole directory: zero runtime code, zero runtime
// imports, so the UI consumes it through the ui-src/types/frames.ts re-export
// (the ui tsconfig has no Node types and tsc must stay green across the split)
// while the host build erases it entirely. Host-side senders re-export the
// payload shapes they own from host/state.ts / host/translate.ts.
// Split note: five files instead of one because scripts/check-architecture.mjs
// caps newly added files at 800 lines.
import type { CapabilityKeysFrame, SearchAvailabilityFrame } from "./payloads";
import type {
  ApprovalModeFrame, ApprovalRequestFrame, ApprovalResolvedFrame, AskDialogQuestionWire, BashChunkFrame, BashCompleteResultFrame,
  BashDoneFrame, BashStartFrame, CommandOutputFrame, CommandPhaseFrame, CommandResultFrame, CommandsFrame,
  ComputerModeFrame, ContextDetailFrame, DirListFrame, EntryTreeFrame, ErrorFrame, FileContentFrame,
  FileDiffFrame, FileMatchesFrame, GitBranchSwitchedFrame, GitBranchesFrame, GitCommitDetailFrame, CommitFileDiffFrame, GitCommittedFrame, GitDiscardedFrame,
  GitGraphFrame,
  GitPushedFrame, GitStagedFrame, GitStatusFrame, GitUnstagedFrame, GoalFrame, ImageContentFrame,
  LimitsResultFrame, MessagesFrame, PlanModeFrame, PlanOutputFrame, PoolSessionsFrame, ProviderAccountEntry, ProviderAccountsFrame,
  ProviderDisabledAccount, ProviderLimitsResultFrame, ReadyFrame, SessionAbortedFrame, SessionArchivedFrame, SessionBranchedFrame,
  SessionCompactedFrame, SessionCreatedFrame, SessionExternalWriteFrame, SessionForkedFrame, SessionListFrame, SessionModelFrame,
  SessionFinishedFrame, SessionNavigatedFrame, SessionRenamedFrame, SessionThinkingFrame, SessionTitleChangedFrame, SessionTreeFrame,
  SessionTextSearchFrame, SessionUnloadedFrame,
  TodosFrame,
} from "./frames-session";
import type {
  AgentAssetsFrame, AllProvidersFrame, AssetFileDeletedFrame, AssetFileFrame, AssetFileSavedFrame, BrowserMirrorFrame,
  BrowserTabInfo, BrowserTabsFrame, CapabilitiesFrame, CapabilitiesMcpFrame, CapabilitiesSnapshot, CycleModelFrame,
  EditorInfo, EditorsFrame, ExtSource, ExtensionDetail, ExtensionItem, ExtensionStatusFrame,
  ExtensionsFrame, LoginDoneFrame, LoginProgressFrame, LoginPromptFrame, ManualProbeCatalogMatch, ManualProbeModel,
  McpServerTestedFrame, MemoryFileFrame, ModelRolesFrame, ModelsCatalogFrame, ModelsConfigPathFrame, ModelsFrame,
  PluginInstallResultFrame, ProfileSwitchedFrame, ProviderKeyDoneFrame, ProviderModelMetaFrame, ProviderModelMetaRow, ProviderModelSavedFrame, ProviderModelTestFrame,
  ProviderModelsProbeFrame, ProviderModelsSavedFrame, SettingsFrame, SettingsSchemaFrame, TerminalCreatedFrame, TerminalDataFrame,
  TerminalExitFrame, UsageStatsFrame,
} from "./frames-models";
import type {
  AutomationPreviewFrame, AutomationRunStartedFrame, AutomationsListFrame, BgJobsFrame, BtwDeltaFrame, BtwHistoryFrame,
  BtwRecord, BtwRecordFrame, BtwTurn, CacheWarmingFrame, CompletionFrame, ContextFrame,
  DisplaysFrame, EventFrame, KeepaliveStatusFrame, KickedFrame, OpenRightTabFrame, QueuedFrame, RemoteConfigFrame, RemoteKeyFrame,
  RemoteWorkspaceAddedFrame,
  SessionStatsFrame, SetLocaleFrame, SshDirsFrame, SshHostsFrame, SshTestResultFrame, SteerConsumedFrame,
  SttDownloadProgressFrame, SttDraftFrame, SttStateFrame, SttSubmitFrame, SttTestResultFrame, SubagentControlledFrame,
  SubagentEventFrame, SubagentLifecycleFrame, SubagentProgressFrame, TtsDeltaFrame, TtsFlushFrame, TtsStopFrame,
  VoiceStatusFrame,
  CollabStateFrame, WorktreeCreatedFrame, WorktreeRemovedFrame, WorktreeStatusResultFrame,
} from "./frames-live";

export * from "./payloads";
export * from "./frames-session";
export * from "./frames-models";
export * from "./frames-live";

/** Discriminated union of all host → UI frames (87 kinds; consumed branch by branch by the store's giant switch, the default path is the fallback for unknown frames) */
export type HostFrame =
  | ReadyFrame
  | ErrorFrame
  | CommandsFrame
  | CommandOutputFrame
  | CommandResultFrame
  | CommandPhaseFrame
  | GoalFrame
  | TodosFrame
  | PlanOutputFrame
  | PlanModeFrame
  | ComputerModeFrame
  | SessionCreatedFrame
  | SessionListFrame
  | PoolSessionsFrame
  | SessionTextSearchFrame
  | SessionUnloadedFrame
  | SessionFinishedFrame
  | MessagesFrame
  | SessionArchivedFrame
  | SessionAbortedFrame
  | SessionRenamedFrame
  | SessionTitleChangedFrame
  | SessionCompactedFrame
  | SessionBranchedFrame
  | SessionTreeFrame
  | EntryTreeFrame
  | SessionNavigatedFrame
  | SessionExternalWriteFrame
  | FileDiffFrame
  | FileContentFrame
  | ImageContentFrame
  | DirListFrame
  | FileMatchesFrame
  | BashStartFrame
  | BashChunkFrame
  | BashDoneFrame
  | BashCompleteResultFrame
  | ContextDetailFrame
  | LimitsResultFrame
  | ProviderLimitsResultFrame
  | ProviderAccountsFrame
  | GitStagedFrame
  | GitUnstagedFrame
  | GitDiscardedFrame
  | GitCommittedFrame
  | GitPushedFrame
  | GitStatusFrame
  | GitBranchesFrame
  | GitGraphFrame
  | GitCommitDetailFrame
  | CommitFileDiffFrame
  | GitBranchSwitchedFrame
  | ApprovalModeFrame
  | ApprovalResolvedFrame
  | ApprovalRequestFrame
  | SessionModelFrame
  | SessionThinkingFrame
  | SettingsFrame
  | SettingsSchemaFrame
  | ModelsFrame
  | CycleModelFrame
  | ModelsCatalogFrame
  | AllProvidersFrame
  | LoginProgressFrame
  | LoginPromptFrame
  | LoginDoneFrame
  | ProviderKeyDoneFrame
  | ModelsConfigPathFrame
  | ProviderModelsProbeFrame
  | ProviderModelSavedFrame
  | ProviderModelMetaFrame
  | ProviderModelTestFrame
  | ProviderModelsSavedFrame
  | ModelRolesFrame
  | CapabilityKeysFrame
  | SearchAvailabilityFrame
  | UsageStatsFrame
  | AgentAssetsFrame
  | ExtensionsFrame
  | AssetFileFrame
  | AssetFileSavedFrame
  | EditorsFrame
  | AssetFileDeletedFrame
  | PluginInstallResultFrame
  | MemoryFileFrame
  | McpServerTestedFrame
  | ProfileSwitchedFrame
  | CapabilitiesFrame
  | CapabilitiesMcpFrame
  | ExtensionStatusFrame
  | TerminalDataFrame
  | TerminalExitFrame
  | TerminalCreatedFrame
  | BrowserTabsFrame
  | BrowserMirrorFrame
  | ContextFrame
  | SessionStatsFrame
  | EventFrame
  | SubagentLifecycleFrame
  | SubagentProgressFrame
  | SubagentEventFrame
  | SteerConsumedFrame
  | QueuedFrame
  | SessionForkedFrame
  | BgJobsFrame
  | SubagentControlledFrame
  | CompletionFrame
  | CacheWarmingFrame
  | SttDraftFrame
  | SttStateFrame
  | SttSubmitFrame
  | TtsDeltaFrame
  | TtsFlushFrame
  | TtsStopFrame
  | SttTestResultFrame
  | SttDownloadProgressFrame
  | VoiceStatusFrame
  | KeepaliveStatusFrame
  | DisplaysFrame
  | SshHostsFrame
  | SshTestResultFrame
  | RemoteWorkspaceAddedFrame
  | SshDirsFrame
  | AutomationsListFrame
  | AutomationRunStartedFrame
  | AutomationPreviewFrame
  | BtwDeltaFrame
  | BtwRecordFrame
  | BtwHistoryFrame
  | OpenRightTabFrame
  | KickedFrame
  | RemoteConfigFrame
  | RemoteKeyFrame
  | CollabStateFrame
  | WorktreeCreatedFrame
  | WorktreeStatusResultFrame
  | WorktreeRemovedFrame;
