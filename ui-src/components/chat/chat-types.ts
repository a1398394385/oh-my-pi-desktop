// P2 close-out: the single source of shared types is ui-src/types/session.ts (the P2-Types
// discriminated union).
// This file survives only as a re-export compatibility layer, saving every renderer from
// import churn; new code should `import type { ... } from "../../types/session"` directly.
// The former P2-C transitional definitions (the single big-bag ChatItem and
// ToolArgs/ToolDetails/AskQuestion) have been merged into types/session.ts.
export type {
  AskQuestion,
  AssistantItem,
  BashItem,
  ChatItem,
  ErrItem,
  LoopItem,
  MentionItem,
  MetaItem,
  PhaseItem,
  RailEntry,
  ThinkingItem,
  ToolArgs,
  ToolDetails,
  ToolItem,
  UserItem,
} from "../../types/session";
