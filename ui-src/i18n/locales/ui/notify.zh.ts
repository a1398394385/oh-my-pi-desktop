// zh copy for the notify domain. Keys are prefixed `notify.` — see ui-src/i18n/README.md.
// Covers store/wsHandlers layer copy: toasts, desktop notifications, connection
// banner text and shared duration formatting.
export const notifyZh = {
  // WS connection status (store/ws.ts)
  connecting: "连接中…",
  noHost: "无宿主",
  hostStartFailed: "宿主启动失败：{{error}}",
  connected: "已连接",
  disconnected: "已断开",
  // Working-state text (store/session.ts)
  working: "正在处理…",
  thinking: "思考中…",
  thinkingLabel: "思考",
  thinkingDone: "思考 · {{label}}",
  thinkingTookSeconds: "持续了几秒",
  // Desktop notifications (store/session.ts, store/wsHandlers/stream.ts)
  approvalTitle: "等待审批",
  bgSessionTitle: "后台会话",
  finished: "已完成",
  // Session lifecycle toasts (store/wsHandlers/session.ts)
  renamed: "已重命名",
  renameFailed: "重命名失败",
  archived: "已归档",
  unarchived: "已取消归档",
  archiveFailed: "归档操作失败",
  generationStopped: "已停止生成",
  contextCompacted: "上下文已压缩",
  compactFailed: "压缩失败",
  forkFailed: "分叉失败",
  forked: "已分叉出新会话",
  navigateFailed: "跳转失败",
  navigated: "已跳转到所选节点",
  // Git operation toasts (store/wsHandlers/files.ts)
  changesDiscarded: "已丢弃更改",
  gitOpFailed: "git 操作失败",
  committed: "已提交 {{sha}}",
  commitFailed: "提交失败",
  pushed: "已推送",
  pushFailed: "推送失败",
  branchSwitched: "已切换分支到 {{branch}}",
  // Settings / config toasts (store/wsHandlers/settings.ts, config.ts)
  savedRestartHint: "已保存，部分网络设置建议重启应用后完全生效",
  profileActivated: "已激活 Profile: {{profile}}",
  loginProgress: "{{provider}}：{{message}}",
  loginOk: "{{provider}} 登录成功，模型列表已刷新",
  loginCancelled: "登录已取消",
  loginFailed: "{{provider}} 登录失败：{{message}}",
  apiKeySaved: "{{provider}} API key 已保存，模型列表已刷新",
  configPath: "配置文件：{{path}}",
  wizardSaved: "{{provider}} 已保存（{{count}} 个模型），已写入 models.yml",
  wizardModelSaved: "{{model}} 元数据已保存到 models.yml",
  skillDeleted: "技能已删除",
  fileDeleted: "文件已删除",
  mcpConnected: "MCP [{{name}}] 连接成功",
  mcpProbeFailed: "MCP [{{name}}] 探测失败: {{error}}",
  // Duration formatting (store/utils.ts)
  durationSec: "{{n}}秒",
  durationMinSec: "{{n}}分{{m}}秒",
  durationHourMin: "{{n}}小时{{m}}分钟",
};

export default notifyZh;
