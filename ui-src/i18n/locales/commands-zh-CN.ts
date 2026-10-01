// Chinese descriptions for built-in slash commands (shown in the / command
// palette). Covers every entry the host's list_commands reports with
// source === "builtin"; skill / extension / file commands keep their original
// text. Translations correspond to the English text the palette actually
// displays (the base's acpDescription ?? description, audited 2026-09);
// migrated unchanged from components/composer/commands-zh.ts.
// Maintenance: when the base adds or changes built-in commands, update the
// translations here; names not present fall back to the English description.

export const BUILTIN_DESC_ZH: Record<string, string> = {
  security: "规划、运行、查看、导入与对比 OMP 原生安全扫描",
  advisor: "开关顾问（第二个模型复审每轮并注入建议）",
  export: "导出会话为 HTML 文件",
  trace: "在统计面板中打开本会话的 trace",
  dump: "返回完整转录纯文本，并给出 LLM 请求 JSON 路径",
  share: "通过加密链接分享会话（分享服务器或 secret gist）",
  browser: "切换 browser 工具的无头/有界面模式",
  goal: "开关目标模式（本会话持久自主目标）",
  plan: "开关计划模式（先只读规划，批准后再执行）",
  todo: "管理待办清单",
  session: "查看或配置当前会话",
  jobs: "查看后台任务",
  usage: "查看 token 用量",
  stats: "打开本地统计面板",
  changelog: "查看更新日志",
  tools: "查看可用工具",
  context: "查看上下文用量",
  mcp: "管理 MCP 服务器",
  ssh: "管理 SSH 连接",
  fresh: "重置供应商流状态（保留本地转录）",
  compact: "压缩对话上下文",
  shake: "把大块内容移出对话上下文",
  handoff: "将会话总结为交接文档并原地压缩",
  pin: "在会话恢复列表顶部置顶/取消置顶",
  retry: "重试上一个失败的 agent 轮次",
  memory: "管理记忆",
  rename: "重命名当前会话（省略标题则自动生成）",
  move: "把当前会话移到其他目录",
  wt: "把本会话（含未提交改动）移入新 worktree",
  "add-dir": "给本会话添加工作区目录",
  "remove-dir": "从本会话移除工作区目录",
  dirs: "列出本会话的工作区目录",
  marketplace: "管理市场插件",
  plugins: "管理插件",
  "reload-plugins": "重新加载全部插件",
};
