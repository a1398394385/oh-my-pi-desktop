// P2 收口:共享类型的唯一来源是 ui-src/types/session.ts(P2-Types 判别联合)。
// 本文件仅作 re-export 兼容层保留,避免各渲染件改动 import;新代码请直接
// `import type { ... } from "../../types/session"`。原 P2-C 过渡定义(单一大 bag ChatItem、
// ToolArgs/ToolDetails/AskQuestion)已并入 types/session.ts。
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
