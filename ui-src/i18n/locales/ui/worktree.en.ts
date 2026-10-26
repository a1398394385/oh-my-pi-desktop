// en copy for the worktree domain (sidebar worktree-session entry: create
// dialog, remove-confirm dialog, RPC bus errors). Keys are prefixed `worktree.`
// — see ui-src/i18n/README.md.
export const worktreeEn = {
  navItem: "Worktree Session",
  notConnected: "Not connected to the host",
  timeout: "Host did not respond in time",

  create: {
    title: "New Worktree Session",
    nameLabel: "Name",
    namePh: "fix-login-bug",
    branchPreview: "Branch: {{branch}}",
    baseLabel: "Base",
    baseHead: "Current checkout (HEAD)",
    baseDefault: "Repository default branch (origin/HEAD)",
    invalidName: "Name must be 1-41 chars of letters, digits or dashes",
    baseMissing: "No git repository available — open or create a session in a repo first",
    submit: "Create Worktree",
    creating: "Creating…",
    failed: "Creation failed",
    openedToast: "Worktree ready — write your first message to start the session",
  },

  remove: {
    title: "Remove Worktree",
    checking: "Checking worktree state…",
    dirtyBody: "This worktree has uncommitted changes: {{staged}} staged, {{unstaged}} unstaged, {{untracked}} untracked. Force remove discards them permanently.",
    forceBtn: "Force Remove (discard changes)",
    cancel: "Keep",
    removing: "Removing…",
    removedToast: "Worktree removed",
    goneToast: "Worktree directory no longer exists",
    removeFailed: "Remove failed",
    notWorktree: "This path is not an omp worktree",
  },

  code: {
    not_a_repo: "Not a git repository",
    invalid_name: "Invalid worktree name",
    not_a_worktree: "Not a git worktree",
    worktree_dirty: "Worktree has uncommitted changes",
  },
};

export default worktreeEn;
