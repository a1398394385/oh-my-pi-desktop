// 全进程共享可变状态的唯一收口。
// 跨模块读写的变量一律挂 H 对象（ESM 裸 let 绑定对 import 方只读，对象属性可跨模块赋值）；
// 引用恒定不变的容器（Map）直接导出。SDK 引用与加载顺序约束见 bootstrap.ts。
import os from "node:os";
import type { createAgentSession } from "./bootstrap.ts";

// ---------- 会话池类型（前置声明，方便 profile 切换时清理） ----------
export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type TranscriptItem = {
  role: "user" | "assistant" | "tool" | "thinking" | "loop" | "bash" | "mention";
  text: string;
  name?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  files?: string[];
  added?: number;
  removed?: number;
  diffContent?: string; // edit/write 当次调用的真实 unified diff（工具回包 details.diff 截断副本）
  todo?: { content: string; done: number; total: number };
  thinking?: string;
  expandable?: boolean;
  output?: string; // bash 类工具的输出文本（截断后），供前端展开卡片展示
  details?: any; // read（文件预览）/hub 等工具的详细运行态元数据
  collapsed?: boolean; // loop 组默认收起；展开态由前端切换
  items?: TranscriptItem[]; // role==="loop" 时收纳本轮过程（thinking/tool/中间 assistant）
  durationSec?: number | null; // 本轮工作时长（秒）
  usage?: TurnUsage | null; // 本轮 LLM token 总消耗
  entryId?: string; // 落盘条目 id（user 消息才有：branch_session 按它定位分叉点）
  // ---- bash 行（role==="bash"，本地 ! 命令执行）----
  running?: boolean; // 执行中（bash_start → bash_done 之间）
  exitCode?: number | null; // 进程退出码；null = 未知/未完成
  cancelled?: boolean; // 被用户中止
  timedOut?: boolean; // 超时杀
  truncated?: boolean; // 输出被截断（底座有上限）
  excludeFromContext?: boolean; // !! 前缀：结果不进模型上下文
  error?: string; // 执行失败错误信息
  // ---- 文件提及行（role==="mention"，@path 已读取）----
};
export type PoolEntry = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionResult: Awaited<ReturnType<typeof createAgentSession>>; // setToolUIContext 等宿主注入点
  unsubscribe: () => void;
  // 当前挂载的 ws：handleLoadSession 命中池内条目时用它判断是否需要重挂订阅
  // （前端 reload 后是新连接，旧订阅发往已关闭的 ws，事件会丢）。只做引用比较，故为 unknown
  attachedWs: unknown;
  // 会话请求凭证的粘性键（= sessionManager.getSessionId()）：get_limits 用它与会话
  // 同参解析 getApiKey，多账号时明细卡配额与本会话实际命中的账号一致
  providerSessionId: string;
  transcript: TranscriptItem[];
  assistantDraft: string; // 当前 turn 的流式文本累积，turn_end 时定稿
  thinkingDraft: string;
  thinkingStartedAt: number | null;
  path: string; // 会话文件路径（磁盘标识）
  cwd: string;
  isGit: boolean;
  queuedTexts: string[]; // 最近一次推送的排队消息文本快照（turn_end 竞态兜底用）
  consumedTexts: string[]; // 已通知 UI 消费（dequeue hook）/已兜底重发的文本
  // followUp 暂存区（含隐藏伴随，原队列元素）：底座注入边界会把 followUp 队列 drain 到排空，
  // 多条排队会被同一轮 run 拼车发出。host 只在底座队列保留 1 条（下一条待消费），其余暂存于此，
  // 每轮 agent_end 放回 1 条并触发消费——排队消息逐轮 FIFO、每轮一条独立 turn
  parkedFollowUp: any[];
  // 会话的 SessionManager 实例：rename（setSessionName）与 compact 后重建 transcript 用
  manager: any;
  // 用户重命名的标题（懒建未落盘的会话 listAll 扫不到，list_sessions 兜底条目经此呈现；
  // 已落盘的以底座 title slot 为准，此字段仅内存兜底）
  title: string | null;
  // fileMention 回读游标：agent_end 时重读 manager.getEntries()，把自该下标起
  // 新增的 fileMention 条目转成 mention 帧下发（底座 prompt() 内部落盘、无对应事件）
  mentionScanIndex: number;
};

// key = 前端持有的 sessionId
export const sessions = new Map<string, PoolEntry>();

export const defaultCwd = os.homedir();

// 桌面项目清单（当前 profile 配置目录下 omp-desktop.json，全路径记录）
export type DesktopProjects = { allProjects: string[]; removedProjects: string[]; expandedProjects: string[]; pinnedSessions: string[]; archivedSessions: string[] };
export type DesktopEnv = { httpProxy: string; noProxy: string; caCerts: string };

export const H = {
  currentProfile: "",
  // 进程级底座（全进程一份，随 activeProfile 动态重载）
  agentDir: "",
  authStorage: undefined as any,
  modelRegistry: undefined as any,
  settings: undefined as any,
  // OMP 登录流程(添加供应商默认入口)进行中标志与提示中转表
  loginInFlight: false,
  loginAbort: null as AbortController | null,
  // 桌面环境代理/证书（agentDir 下 desktop-env.json）
  desktopEnvPath: "",
  desktopEnvFilePresent: false,
  desktopEnv: { httpProxy: "", noProxy: "", caCerts: "" } as DesktopEnv,
  // 桌面项目清单
  desktopProjectsPath: "",
  desktopProjects: { allProjects: [], removedProjects: [], expandedProjects: [], pinnedSessions: [], archivedSessions: [] } as DesktopProjects,
  // 模型目录（随 profile / 登录 / 启停刷新）
  availableModels: [] as any[],
  scopedModels: [] as any[],
  modelOverride: undefined as any,
  cachedProfiles: ["default", "omp-desktop"] as string[],
};

// enabledModels 条目 "provider/id:thinking" 的默认思考级别
export const enabledDefaults = new Map<string, string | null>();
// 登录流程 onPrompt 中转表：id -> resolve
export const loginPendingPrompts = new Map<number, (text: string) => void>();
