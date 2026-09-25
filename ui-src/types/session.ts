// 会话条目判别联合 + openSessions 容器 + 全局 store S 的形状类型。
// 条目字段以 components/chat/items.tsx appendItem/renderItems 分发处的实际读取为准
// (items.tsx:21-69 逐 role 分发、:87 pending steer、:95-131 合并组伪条目);
// 线上形状锚定 host/state.ts TranscriptItem(messages 帧,见 ./frames);
// meta/err 为前端本地条目(store.ts 推送,不经 host)。
// 可变展开标志(expanded/branching/cmdExpanded/diffExpanded/readExpanded/briefDiff 等)
// 由组件就地写入条目对象(引用稳定,跨全量重绘保留),故全部声明为可选可写。

import type {
  ContextDetailFrame,
  FileMatch,
  GoalState,
  LimitsResultFrame,
  LoginPromptFrame,
  ModelCatalogEntry,
  ModelRoleEntry,
  AllProviderEntry,
  AssetFileFrame,
  PromptAttachment,
  ProviderLimitsResultFrame,
  QueuedMessage,
  SessionStatsPayload,
  SettingsPayload,
  SlashCommand,
  TodoPhase,
  TurnUsage,
  UsageStats,
  AgentAssetsPayload,
  DiskSessionRow,
  ApprovalMode,
} from "./frames";
// SchemaDef 是设置 schema 条目的权威形状(SETTINGS_SCHEMA 对齐),定义在 settings/placement.ts
import type { SchemaDef } from "../components/settings/placement";

// ---------- 工具 args/details(items.tsx 经 util.ts 谓词读取的点;字段清单自 P2-C chat-types.ts 并入) ----------

/** ask 工具的 questions 结构化参数(ApprovalCard/提问行读取) */
export interface AskQuestion {
  question?: string;
  multi?: boolean;
  header?: string;
  recommended?: number;
  options?: { label?: string; description?: string }[];
}

/** 工具 args:host 工具帧透传的参数 JSON。只约束本仓实际读取的字段
    (类型按 host 协议取值),其余键经索引签名以 unknown 透传 */
export interface ToolArgs {
  path?: string; // items.tsx:115-118 设备组判定(isDeviceEvent → args?.path)
  files?: string[];
  command?: string;
  pattern?: string;
  // 设备调用 JSON 字符串(deviceCmd 运行时再解析),形状不定
  content?: unknown;
  op?: string;
  name?: string;
  application?: string;
  // hub application 参数列表
  args?: unknown[];
  text?: string;
  task?: string;
  i?: string;
  query?: string;
  memory?: string;
  id?: string;
  action?: string;
  program?: string;
  file?: string;
  line?: number;
  repo?: string;
  title?: string;
  pr?: string;
  symbol?: string;
  new_name?: string;
  memories?: { content?: string }[];
  questions?: (AskQuestion | null)[];
  [key: string]: unknown;
}

/** 工具回包 details:host 结构化数据。只约束本仓实际读取的字段,其余透传 */
export interface ToolDetails {
  isDirectory?: boolean; // items.tsx:103-106 查阅组判定(isReadEvent → details?.isDirectory)
  resolvedPath?: string; // parts.tsx openReadFileInSidebar 读取
  displayContent?: {
    // parts.tsx openReadFileInSidebar 读取(读取行内联展示的节选内容)
    text?: string;
    startLine?: number;
    lineNumbers?: number[] | null;
  };
  [key: string]: unknown;
}

// ---------- 会话条目判别联合 ----------

/** user 消息(items.tsx:21-23 读 text;:87 读 pending === "steer" 收集待消费气泡) */
export interface UserItem {
  role: "user";
  text: string;
  pending?: string | null; // "steer" = 流式中发送、待消费(store.ts 落地)
  steerDone?: boolean; // 消费完成标记(store.ts 写入)
  entryId?: string; // 落盘条目 id(branch_session 分叉定位;host TranscriptItem.entryId)
}

/** assistant 消息(items.tsx:25-28 读 text;junk 占位符不渲染) */
export interface AssistantItem {
  role: "assistant";
  text: string;
  entryId?: string; // output 尾部分叉锚点(host turn_end.assistantEntryId 回填)
  endMs?: number; // 该轮结束时刻
  branching?: boolean; // 分叉请求进行中(TurnActs 就地写入)
  streaming?: boolean; // 生成中(组件就地写入)
}

/** thinking 行(items.tsx:30-33 读 item.thinking || item.text) */
export interface ThinkingItem {
  role: "thinking";
  text: string;
  thinking?: string; // 思考正文(与 text 分离时优先)
  expandable?: boolean; // 可展开(有完整思考块)
  expanded?: boolean; // 展开态(组件就地写入)
  streaming?: boolean; // 思考进行中(store.ts 就地写入:thinking_delta 按此找累积目标)
}

/** 工具行(items.tsx:35-37 整条目传 ToolRow;:95-131 合并组伪条目 { role:"tool", text, name?, group }) */
export interface ToolItem {
  role: "tool";
  text: string;
  name?: string; // 合并组伪条目标 "read"/"device"/"cmd" 供 toolKind 分发(items.tsx:106/118/129)
  toolCallId?: string;
  args?: ToolArgs;
  files?: string[];
  details?: ToolDetails;
  group?: ChatItem[]; // 合并组(更改/查阅/终端/设备)收纳的成员条目(运行期均为 tool 条目)
  output?: string;
  added?: number;
  removed?: number;
  running?: boolean; // 执行中(store.ts 落地:tool 帧置位、tool_update 复位;clearRunningTools 兜底)
  todo?: { content?: string; total?: number; done?: number };
  diffContent?: string;
  streaming?: boolean; // 执行中(组件就地写入)
  cmdExpanded?: boolean; // 终端输出展开(组件就地写入)
  diffExpanded?: boolean; // diff 展开(组件就地写入)
  readExpanded?: boolean; // 查阅内容展开(组件就地写入)
  briefDiff?: string; // 行内联展开的单文件 diff(组件就地写入)
}

/** loop 组(items.tsx:39-42 整条目传 LoopGroup;组内收纳本轮过程条目) */
export interface LoopItem {
  role: "loop";
  text: string;
  items?: ChatItem[]; // 本轮过程(thinking/tool/中间 assistant)
  collapsed?: boolean; // 默认收起;展开态由前端切换
  durationSec?: number | null;
  usage?: TurnUsage | null;
}

/** 本地 bash 行(! 前缀;items.tsx:44-46 读 text) */
export interface BashItem {
  role: "bash";
  text: string; // 命令原文
  output?: string; // 输出文本(截断后)
  running?: boolean; // bash_start → bash_done 之间
  exitCode?: number | null;
  cancelled?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean; // !! 前缀
  error?: string | null; // 执行失败错误信息
  cmdExpanded?: boolean; // 输出展开(组件就地写入)
}

/** @ 提及回读行(items.tsx:48-50 读 item.files) */
export interface MentionItem {
  role: "mention";
  text: string; // 线上恒 ""(host attachEntry 扫描直推)
  files?: string[];
}

/** 居中文案行(items.tsx:52-55 读 text;前端本地条目,不经 host) */
export interface MetaItem {
  role: "meta";
  text: string;
}

/** 阶段分隔行(items.tsx:57-65 读 text;压缩/交接/重命名) */
export interface PhaseItem {
  role: "phase";
  text: string;
  phase?: "start" | "done"; // start 仅来自瞬时帧;落盘转出皆为 done
  command?: string; // compact/handoff/rename:start 行与 done 行按此对照吸收
}

/** 错误行(items.tsx:67-69 兜底分支读 text;前端本地条目,不经 host。
    role 为 "error" 对齐 store.ts error 帧落地值,SessionRow 亦按此判定会话错误态) */
export interface ErrItem {
  role: "error";
  text: string;
}

/** 会话条目判别联合(role 字面量判别;items.tsx appendItem 逐分支消费) */
export type ChatItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | LoopItem
  | BashItem
  | MentionItem
  | MetaItem
  | PhaseItem
  | ErrItem;

/** 兼容别名:store.ts 批的条目类型名(收口接线后统一为 ChatItem) */
export type SessionItem = ChatItem;

/** 消息轨道刻度(items.tsx 各 railEntries.push 点;MsgRail 按 key 查 DOM 定位) */
export interface RailEntry {
  key: string; // 与 data-fk 锚点同源
  role: string; // "user" | "assistant" | "thinking" | "tool" | "meta" | "bash" | "mention" | "err"
  text: string;
}

// ---------- openSessions 容器 ----------

/** 挂起审批(store.ts:991-998 approval_request 落地;ApprovalCard 消费) */
export interface PendingApproval {
  requestId: string;
  title: string;
  options: string[];
  editable: boolean;
  prefill: string;
  answer: string | null; // 用户已选答案;null = 未决
}

/** 子代理工具调用行(store.ts subagent_event 累积) */
export interface SubagentToolCall {
  name: string;
  args?: unknown;
  files?: string[];
  toolCallId?: string;
  running: boolean;
  added?: number;
  removed?: number;
  todo?: unknown;
  output?: string;
  details?: unknown;
  diffContent?: string;
}

/** 子代理聚合用量(store.ts subagent_progress 落地) */
export interface SubagentUsage {
  cost?: number;
  durationMs?: number;
  requests?: number;
  toolCount?: number;
  tokens?: Record<string, number>; // TODO(收口核对): 底座 progress 分桶对象,随 SDK
  contextTokens?: number;
  contextWindow?: number;
  currentTool?: string;
  currentToolArgs?: unknown;
  currentToolStartMs?: number;
  lastIntent?: string;
  resolvedModel?: string;
  resolvedThinkingLevel?: string;
  recentTools?: unknown[];
}

/** 子代理运行态(store.ts subagent_lifecycle 落地 + progress/event 累积) */
export interface SubagentState {
  agent: string;
  description: string;
  status: string;
  name?: string;
  parent?: string;
  registeredAt?: number;
  text: string; // 子代理文本 delta 累积
  tools: SubagentToolCall[];
  streaming: boolean;
  usage?: SubagentUsage;
}

/** 已打开会话(openSessions 容器值;store.ts openSessions.set(msg.path, {...}) 创建,
    后续字段由帧处理/组件交互在运行期写入,非创建时必有) */
export interface OpenSession {
  sessionId: string;
  cwd: string;
  items: ChatItem[];
  pendingApprovals?: PendingApproval[];
  assistantDraft: string;
  streaming: boolean;
  turnStartAt?: number | null;
  turnItemStart?: number | null; // 本轮条目起点(sealRunItems 用)
  workingText?: string | null; // 处理进程区文案(正在处理…/思考中…/intent)
  subagents: Map<string, SubagentState>;
  model: string | null;
  thinking: string;
  isGit: boolean;
  todos: TodoPhase[];
  goal?: GoalState | null; // goal 帧置位
  planMode?: boolean; // plan_mode 帧置位
  queued?: QueuedMessage[]; // queued 帧 followUp 落地
  steering?: QueuedMessage[]; // queued 帧 steering 落地
  externalWrite?: boolean; // 宿主检出外部进程写入
  autoResolved?: string; // thinking_level 帧 configured==="auto" 时的 resolved 生效值
  ctx?: { tokens: number; window: number; percent: number }; // context 帧落地
  stats?: SessionStatsPayload; // session_stats 帧落地
  title?: string | null; // 会话标题（session_title_changed 或创建时带入）
}

/** openSessions 容器:key = 会话文件路径(store.ts openSessions;LRU 上限 8) */
export type OpenSessions = Map<string, OpenSession>;

// ---------- 全局 store S ----------

/** file_view 文件页视图态(store file_content 帧回包补全;FilePage/parts.tsx 就地构造)。
    非 FileContentFrame 子集:前端本地态(reqRange/image/full)与帧字段混装,故独立声明 */
export interface FileViewState {
  path: string;
  text?: string; // 已读到的内容(节选或全文件)
  error?: string | null; // 读取失败信息
  startLine: number; // text 首行对应的全文件行号
  lineNumbers: (number | null)[] | null; // 节选行号清单(行号高亮用;null 元素 = 工具省略的空洞行);全文件为 null
  full?: boolean; // 已是全文件(file_content 回包置位)
  reqRange: [number, number] | null; // 请求的行号范围(path:59-123 选择器解析而来)
  image?: boolean; // 图片预览分支(read_image 回包走 rightState.imageContent)
}

/** 记忆文件落地(store.ts memory_file 帧;status: idle/loading/done/error) */
export interface MemoryDetailState {
  base: string | null;
  files: string[] | null;
  rollouts: string[];
  active: { name: string; rollout: boolean } | null;
  status: string;
  content: string;
  error: string | null;
}

/** 全局状态 S 的形状(store.ts S 声明;字段名与 core.js 一致) */
export interface AppState {
  activePath: string | null;
  selectedSubagent: string | null;
  ws: WebSocket | null;
  pendingCreate: boolean;
  hostSettings: SettingsPayload | null;
  settingsSchema: Record<string, SchemaDef> | null; // SettingsSchemaFrame["schema"];条目形状同 SETTINGS_SCHEMA
  modelCatalog: ModelCatalogEntry[];
  selectedProvider: string | null;
  mpAddView: boolean;
  mpRolesView: boolean;
  modelRoles: ModelRoleEntry[] | null;
  mpDetailProv: AllProviderEntry | null; // 供应商详情页当前供应商(卡片点击写入)
  allProvidersCache: AllProviderEntry[] | null;
  loginBusy: boolean;
  agentAssets: AgentAssetsPayload | null;
  usageStats: UsageStats | null;
  isCreatingNew: boolean;
  newSessionProject: string;
  newSessionBranch: string;
  newSessionBranches: string[]; // git_branches 帧 branches 落地(新建会话页分支选择;分支名清单)
  newSessionIsGit: boolean;
  newSessionModel: string;
  newSessionThinking: string;
  defaultModelCfg: string | null; // models 帧 defaultModel 落地
  defaultThinkingCfg: string | null; // models 帧 defaultThinking 落地
  newSessionDirty: boolean;
  pendingNewPrompt: { text: string; files: PromptAttachment[] } | null;
  pendingFiles: (PromptAttachment & { id: number })[]; // 输入框附件 chip(带前端本地 id,发送时剥离)
  fileSeq: number;
  viewMode: string; // "project" | …(侧栏视图)
  isProjectManageMode: boolean;
  allProjects: string[];
  removedProjects: string[];
  archivedSessions: (DiskSessionRow & { cwd: string })[];
  animateGdKids: boolean;
  animateThinkBody: boolean;
  animateSubKids?: boolean; // 子代理详情入场动画标记(运行时挂上,SubagentPage 专用)
  todoCollapsed: boolean;
  gitViewMode: string; // "tree" | …(右栏 Git Diff 视图)
  selectedFile: string | null;
  fileView: FileViewState | null;
  fileViewPending: string | null; // 请求中的文件路径
  briefDiffPending: string | null; // 请求中的行内 diff 路径
  rightTab: string;
  zoomLevel: number;
  approvalMode: ApprovalMode;
  loginReqId: number;
  evtHost: string | null; // host 进程实例 ID(ready.hi / 盖戳事件.hi);变化 = host 已重启
  evtSeq: number; // 该实例下已应用的最高事件序号(位置落后的事件直接丢弃)
  // ---- React 版新增 UI 态(原版散在 DOM class / 局部变量上) ----
  connected: boolean;
  connText: string;
  toastMsg: string | null; // 当前 toast 文本(null = 隐藏)
  composerSetSignal: { text: string; images: unknown[] | null; seq: number } | null; // 外部填输入框的信号(分叉回填 / 排队消息编辑)
  findOpen: boolean; // 会话内查找栏开合(FindBar 同步;Esc 中断生成前的守卫)
  menuSignal: { name: string; seq: number } | null; // 外部打开 composer 菜单的信号(快捷键 Alt+M)
  draftHasContent: boolean; // 输入框是否有草稿(Composer 每次渲染同步,Esc 二次确认用)
  escArmedUntil: number; // Esc 二次确认窗口的截止时刻(> 现在 = 发送钮显示取消图标)
  // ---- 输入框 sigil 补全态 ----
  commands: SlashCommand[] | null; // 当前会话斜杠命令清单(null = 未拉取,弹层显示加载中)
  commandsSessionId: string | null; // 清单归属会话 id,切会话即失效
  mentionReqSeq: number; // list_files 请求序号(reqId 生成器,前端自增)
  mentionResult: { reqId: number; matches: FileMatch[] } | null; // 最新 @ 候选响应;reqId 不匹配即过期
  sidebarCollapsed: boolean;
  rightCollapsed: boolean;
  // ---- 设置中心 ----
  settingsOpen: boolean; // 全屏 overlay 开合
  settingsPage: string; // 当前设置页 id
  providerLimits: ProviderLimitsResultFrame | null;
  loginBanner: string | null; // OMP 登录进度横幅文本
  loginPromptData: LoginPromptFrame | null; // login_prompt 粘贴码弹窗数据
  assetFile: AssetFileFrame | null; // asset_file 回包(skills/agents 编辑器按 kind 过滤)
  assetFileSaved: { kind: string; at: number } | null; // asset_file_saved 落地(引用变化驱动「已保存」态)
  assetSaved: { kind: string; at: number } | null; // 同上,agents 页消费
  assetErr: { kind: string; message: string; at: number } | null; // error 帧带 kind 时落地
  mcpTestResults: Record<string, { status: string; error?: string; ts: number }>; // MCP 单服务器测试结果:name -> { status, error?, ts }
  memoryDetail: MemoryDetailState; // memory_file 帧落地
  // ---- ringpop 弹卡瞬态数据(hover 上下文环明细卡,移开即弃,下次悬停清零重请求) ----
  ctxDetail: ContextDetailFrame | null;
  ctxLimits: LimitsResultFrame | null;
}
