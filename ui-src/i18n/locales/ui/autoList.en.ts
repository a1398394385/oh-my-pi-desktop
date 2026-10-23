// en counterpart of autoList.zh.ts — keep keys in sync.
export const autoListEn = {
  title: "Automations",
  // Status filter pills (zcode automationStatusFilter semantics)
  filterAll: "All",
  filterActive: "In progress",
  filterCompleted: "Completed",
  filterFailed: "Failed",
  // Card badges
  pausedBadge: "Paused",
  failedBadge: "Failed",
  runCount: "{{n}} runs",
  // Delivery badge: the run wakes an existing conversation instead of spawning a session
  deliveryBadge: "Delivers to a conversation",
  cardNext: "next run {{time}}",
  // Header gear: opens the automations settings page (agent tool switch)
  settingsTitle: "Automation settings",
  // Row action menu
  moreActions: "More actions",
  edit: "Edit",
  // Relative next-run time (≤30d relative, beyond that absolute via formatLocalTime)
  relSoon: "soon",
  relMinutes: "{{n}} min",
  relHours: "{{n}} h",
  relDays: "{{n}} d",
  relIn: "in {{amount}}",
  // Empty states
  emptyTitle: "No automations",
  filterEmpty: "No tasks match this filter",
};

export default autoListEn;
