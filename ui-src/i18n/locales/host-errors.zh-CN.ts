// Host-side error & validation messages (zh-CN): RPC throw frames, parameter
// checks, removed-slash-command notices. Keys are prefixed `errors.`;
// consumed via the host i18n instance (ui-src/i18n/host.ts).
// zh values must stay verbatim identical to the copy that used to live inline
// in host/ sources (wave-3 H1 extraction) — rewording needs a design review.
export const hostErrorsZh = {
  unknownCommand: "未知命令: {{type}}",
  invalidProfileName: "Profile 名称不合法: {{detail}}",
  unknownSetting: "未知设置项: {{key}}",
  commandFailed: "命令执行失败: {{detail}}",
  param: {
    missingPath: "缺少 path",
    missingCwd: "缺少 cwd",
    missingOrder: "缺少 order",
    missingTitle: "缺少 title",
    missingEntryId: "缺少 entryId",
    missingPaths: "缺少 paths",
    missingMessage: "缺少 message",
    missingBranch: "缺少 branch",
    missingProvider: "缺少 provider",
    missingProviderId: "缺少供应商 id",
    missingMcpName: "缺少 MCP 服务器名称",
    missingSkillName: "缺少技能名称",
    missingSubagentId: "缺少 subagentId",
  },
  subagent: {
    invalidAction: "不支持的控制动作: {{action}}",
    registryUnavailable: "子代理注册表不可用",
  },
  session: {
    notFound: "会话不存在: {{sessionId}}",
    invalidTitle: "标题无效（清洗后为空或会话已释放）",
    emptyNoCompact: "会话为空，没有可压缩的历史",
    emptyNoFork: "会话为空，没有可分叉的内容",
    cannotLocateSource: "无法定位源会话文件",
    entryNotFound: "未找到条目: {{entryId}}",
    forkCreateFailed: "分叉创建新会话文件失败",
    fileNotOnDisk: "会话文件不在磁盘上: {{path}}",
    alreadyAtPosition: "已在当前位置",
    navigateCancelled: "导航被取消",
    summaryAborted: "分支摘要已中止",
  },
  prompt: {
    emptyMessage: "消息为空",
    imageOnlyFallback: "请查看附件图片。",
    subagentReadonly: "子代理会话为只读，不支持发送消息",
    subagentSlashNotSupported: "子代理会话暂不支持 Slash 命令与终端命令",
  },
  bash: {
    busy: "已有 bash 命令在执行，先按停止或等它结束",
  },
  removedCmd: {
    template: "/{{command}} 已移除：{{hint}}",
    useModelCapsule: "模型切换请用输入框的模型胶囊",
    prewalkRemoved: "模型交接已移除",
    fastRemoved: "服务档（fast）切换已移除",
    skillsSettingPage: "技能清单开关请到设置页操作",
    extContextSettingPage: "扩展上下文开关请到设置页操作",
    computerSettingPage: "电脑控制开关请到设置页操作",
    forceRemoved: "强制工具选择已移除",
    useForkButton: "会话分叉请点击回复下方的分叉按钮",
  },
  file: {
    notAFile: "不是文件: {{path}}",
    notADirectory: "不是目录: {{path}}",
    tooLarge: "文件过大（{{size}} MB），仅支持 2MB 内的文本文件",
    binaryNoPreview: "二进制文件，不支持文本预览",
  },
  image: {
    unsupportedFormat: "不支持的图片格式: {{ext}}（仅 png/jpg/jpeg/gif/webp/bmp/svg）",
    noExtension: "无后缀",
    tooLarge: "图片过大（{{size}} MB），仅支持 8MB 内",
  },
  git: {
    commandFailed: "git {{command}} 失败（exit {{exitCode}}）",
    diffFailed: "git diff 失败: {{detail}}",
    statusFailed: "git status 失败: {{detail}}",
    notARepo: "非 git 仓库",
    checkoutFailed: "切换分支失败: {{detail}}",
  },
  setting: {
    mustBeBoolean: "{{key}} 必须是布尔值",
    mustBeNumber: "{{key}} 必须是有限数字",
    mustBeString: "{{key}} 必须是字符串",
    mustBeOneOf: "{{key}} 必须是 {{values}} 之一",
    mustBeArray: "{{key}} 必须是数组",
    arrayItemString: "{{key}} 元素必须是字符串",
    mustBeObject: "{{key}} 必须是对象",
    askTimeoutNonNegative: "ask.timeout 必须是非负秒数",
    invalidLocale: "非法语言: {{lang}}",
    profileEmpty: "Profile 名称不能为空",
    invalidApprovalMode: "非法审批模式: {{mode}}",
    approvalNotFound: "审批请求不存在或已结束: {{requestId}}",
  },
  memory: {
    outsideDir: "路径不在允许的记忆目录内: {{path}}",
    noMdFiles: "记忆目录内没有 .md 文件: {{path}}",
  },
  asset: {
    invalidName: "名称仅允许小写字母、数字、-、_",
    alreadyExists: "{{kind}} 已存在: {{name}}",
    skillFileNotFound: "技能文件不存在: {{file}}",
    unknownProject: "未知的项目: {{c}}",
    unknownScope: "未知的作用域: {{s}}",
    jsonTomlOnly: "仅支持 .json 或 .toml 配置文件: {{raw}}",
    mdOnly: "仅支持 .md {{kind}} 定义文件",
    skillDirForbidden: "路径不在允许的技能目录内: {{raw}}",
    dirForbidden: "路径不在允许的 {{kind}} 目录内: {{raw}}",
    invalidToolName: "工具名仅允许字母、数字、-、_ 或 *",
    invalidPhase: "钩子 phase 只能是 pre 或 post",
    hookExtOnly: "仅支持钩子脚本文件 (.ts/.js/.mjs/.cjs/.sh/.bash/.py): {{raw}}",
  },
  plan: {
    notActive: "计划模式未激活",
  },
  extension: {
    invalidId: "非法扩展 id: {{id}}",
  },
  model: {
    unknown: "未知模型: {{model}}",
    keepAtLeastOne: "至少保留一个启用模型",
    noneAfterFilter: "启用列表过滤后没有可用模型",
    invalidRoleName: "非法角色名: {{role}}",
    roleUnresolved: "角色「{{role}}」没有解析到可用模型",
  },
  limits: {
    noModelSelected: "会话尚未选择模型",
  },
  login: {
    inFlight: "已有登录流程进行中，请完成或稍后再试",
    noneInFlight: "当前没有进行中的登录流程",
    keyEmpty: "API key 不能为空",
    browserOnly: "{{provider}} 仅支持浏览器登录授权，不支持 API key",
  },
  account: {
    notFound: "账号不存在或已恢复",
    restoreUnsupported: "当前 profile 无本地凭据库，无法恢复已停用账号，请重新登录",
  },
  queue: {
    parkedNotFound: "暂存排队消息不存在: {{index}}",
    messageNotFound: "排队消息不存在: {{index}}",
    steerNotFound: "steer 消息不存在: {{index}}",
  },
  pty: {
    startTimeout: "PTY 子进程启动超时",
  },
  host: {
    initFailed: "宿主初始化失败: {{detail}}",
    invalidJson: "非法 JSON",
  },
  mcp: {
    userCancelled: "用户中止生成",
  },
  wizard: {
    missingBaseUrl: "缺少 baseUrl",
    invalidProviderName: "供应商名称不能为空且不能包含空白字符",
    noModels: "未选择任何模型",
    badInput: "输入类型取值无效（仅支持 text / image）",
    badThinking: "思考配置无效（模式或级别取值错误，级别至少一项）",
  },
};

export default hostErrorsZh;
