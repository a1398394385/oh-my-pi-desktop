// zh copy for the automations main-column list page (components/main/automations/AutomationsPage.tsx).
// Keys are prefixed `autoList.` — see ui-src/i18n/README.md. Reusable strings (next-run,
// delete confirm, saved toast, refresh, new/enable tips…) keep living under
// settingsPage.automations.* / settingsPage.shared.* / settingsPage.model.* / common.*.
export const autoListZh = {
  title: "自动化",
  // Status filter pills (zcode automationStatusFilter semantics)
  filterAll: "全部",
  filterActive: "进行中",
  filterCompleted: "已完成",
  filterFailed: "失败",
  // Card badges
  pausedBadge: "已暂停",
  failedBadge: "失败",
  runCount: "已运行 {{n}} 次",
  // Delivery badge: the run wakes an existing conversation instead of spawning a session
  deliveryBadge: "投递到会话",
  cardNext: "下次运行 {{time}}",
  // Header gear: opens the automations settings page (agent tool switch)
  settingsTitle: "自动化设置",
  // Row action menu
  moreActions: "更多操作",
  edit: "编辑",
  // Relative next-run time (≤30d relative, beyond that absolute via formatLocalTime)
  relSoon: "即将",
  relMinutes: "{{n}} 分钟",
  relHours: "{{n}} 小时",
  relDays: "{{n}} 天",
  relIn: "{{amount}}后",
  // Empty states
  emptyTitle: "无自动化",
  filterEmpty: "该状态下暂无任务",
};

export default autoListZh;
