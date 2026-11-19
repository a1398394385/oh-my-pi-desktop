// zh-CN copy for the worktree domain (sidebar worktree-session entry: create
// dialog, remove-confirm dialog, RPC bus errors). Keys are prefixed `worktree.`
// — see ui-src/i18n/README.md.
export const worktreeZhCn = {
  navItem: "Worktree 会话",
  notConnected: "未连接到宿主进程",
  timeout: "宿主进程响应超时",

  create: {
    title: "新建 Worktree 会话",
    nameLabel: "名称",
    namePh: "fix-login-bug",
    branchPreview: "分支：{{branch}}",
    baseLabel: "基线",
    baseHead: "当前检出（HEAD）",
    baseDefault: "仓库默认分支（origin/HEAD）",
    invalidName: "名称仅限 1-41 个字母、数字或连字符",
    baseMissing: "没有可用的 git 仓库——请先在某个仓库中打开或新建会话",
    submit: "创建 Worktree",
    creating: "创建中…",
    failed: "创建失败",
    openedToast: "Worktree 已就绪——输入第一条消息即开始会话",
  },

  toggle: {
    label: "Worktree",
    tooltip: "在仓库的隔离副本中开始会话（检出当前 HEAD，不带未提交改动）。副本里的提交是游离提交，删除副本前请自行迁出。",
    unavailable: "该仓库还没有任何提交，无法检出副本",
    waiting: "正在创建副本…",
  },

  remove: {
    title: "移除 Worktree",
    checking: "正在检查 worktree 状态…",
    dirtyBody: "该 worktree 存在未提交改动：{{staged}} 个已暂存、{{unstaged}} 个未暂存、{{untracked}} 个未跟踪。强制移除将永久丢弃这些改动。",
    forceBtn: "强制移除（丢弃改动）",
    cancel: "保留",
    removing: "移除中…",
    removedToast: "Worktree 已移除",
    goneToast: "Worktree 目录已不存在",
    removeFailed: "移除失败",
    notWorktree: "该路径不是 omp worktree",
  },

  code: {
    invalid_name: "worktree 名称不合法",
    missing_base: "缺少用于创建 worktree 的基础目录",
    not_a_repo: "不是 git 仓库",
    worktree_create_failed: "无法创建 worktree",
    missing_path: "缺少 worktree 路径",
    status_failed: "无法读取 worktree 状态",
    not_a_worktree: "不是 git worktree",
    worktree_dirty: "worktree 存在未提交改动",
    worktree_remove_failed: "无法移除 worktree",
    start_ref_unresolvable: "仓库还没有任何提交",
    start_ref_missing_subdir: "项目目录在当前检出中不存在",
    worktree_root_tracked: ".omp/worktrees 下已存在被跟踪文件，请先取消跟踪",
  },
};

export default worktreeZhCn;
