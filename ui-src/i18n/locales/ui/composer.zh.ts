// zh copy for the composer domain. Keys are prefixed `composer.` — see ui-src/i18n/README.md.
export const composerZh = {
  // Composer.tsx
  placeholder: "随时提问，@ 提及，/ 选择操作",
  addContext: "添加上下文",
  permissionMode: "权限模式",
  planOnTitle: "计划模式已开启，点击退出",
  planLabel: "计划",
  computerOnTitle: "Computer Use 已开启，点击关闭",
  computerOffTitle: "Computer Use 已关闭，点击开启",
  bgCommands: "后台命令",
  subagents: "子智能体",
  switchModel: "切换模型",
  thinkLevel: "思考级别",
  sendEscAgain: "再按一次 Esc 中断生成",
  stopCommand: "停止命令",
  stopGeneration: "停止生成",
  sendQueued: "发送（排队，当前任务完成后发出）",
  send: "发送",
  modelFallback: "模型",
  thinkFallback: "思考",
  needSession: "先新建或打开一个会话",
  oversizeFile: "「{{name}}」超过 10MB，未添加",
  readFail: "读取「{{name}}」失败",
  imageN: "图片{{n}}",
  voiceHoldTitle: "按住说话，松开结束",
  voiceListening: "正在听写，松开结束",
  voiceTranscribing: "正在转写…",
  // ModeMenu.tsx
  modeAlwaysAsk: "手动批准",
  modeAlwaysAskCached: "询问并记住",
  modeWrite: "默认",
  modeYolo: "完全访问",
  modeSmart: "智能审批",
  planMode: "计划模式",
  planModeHint: "先只读规划，批准计划后再执行",
  // ModelMenu.tsx
  noModels: "未配置可用模型",
  modelRoleCategory: "模型角色",
  onlyOneRoleModel: "仅有一个可用的角色模型",
  manageModels: "管理模型",
  visionTag: "视觉",
  reasoning: "推理强度",
  // Same copy as the settings page's defaultThinkingLevel options (OPTS_ZH)
  thinkingLevels: { auto: "自动", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", off: "关" },
  // QueueCard.tsx
  queuedHint: "排队中：当前任务完成后自动发送",
  noText: "（无文本）",
  sendNow: "立即发送（当前步骤后注入）",
  editQueued: "编辑（放回输入框）",
  moveUp: "上移",
  moveDown: "下移",
  // AttachRow.tsx
  remove: "移除",
  // GoalCard.tsx
  resumeGoal: "继续目标 (/goal resume)",
  pauseGoal: "暂停目标 (/goal pause)",
  dropGoal: "删除目标 (/goal drop)",
  // PaletteMenu.tsx
  noMatch: "无匹配",
};

export default composerZh;
