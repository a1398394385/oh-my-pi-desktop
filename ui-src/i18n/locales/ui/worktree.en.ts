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

  toggle: {
    label: "Worktree",
    tooltip: "Start this session in an isolated copy of this repository, checked out at the current HEAD. Commits made inside are detached and can be garbage-collected once the copy is removed.",
    unavailable: "This repository has no commits yet — nothing to check out",
    waiting: "Creating worktree…",
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
    invalid_name: "Invalid worktree name",
    missing_base: "No base folder to create the worktree from",
    not_a_repo: "Not a git repository",
    worktree_create_failed: "Could not create the worktree",
    missing_path: "No worktree path given",
    status_failed: "Could not read the worktree state",
    not_a_worktree: "Not a git worktree",
    worktree_dirty: "Worktree has uncommitted changes",
    worktree_remove_failed: "Could not remove the worktree",
    start_ref_unresolvable: "The repository has no commits yet",
    start_ref_missing_subdir: "The project folder does not exist in the current checkout",
    worktree_root_tracked: "Tracked files already exist under .omp/worktrees — untrack them first",
  },
};

export default worktreeEn;
