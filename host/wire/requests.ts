// UI -> host request direction of the wire contract (A10). The method-name set
// mirrors the host rpcHandlers key set (the per-domain handler tables in
// host/rpc/*.ts; scripts/check-capabilities.mjs asserts the two stay in sync).
// Payload checking is progressive: LooseHostRequest accepts any extra fields as
// long as the method name is real, so unmigrated send() call sites compile
// unchanged while a misspelled or retired method name is a compile error.
// Migrating a call site to full payload checking means replacing its
// `type`-string with a typed member added to RpcRequest below.

/** Every method name the host dispatches (mirror of the rpcHandlers key set). */
export type HostRequestMethod =
  "abort_session" | "add_project" | "add_remote_workspace" | "approval_response" | "archive_session" | "asset_file_create" |
  "asset_file_read" | "asset_file_write" | "asset_plugin_toggle" | "asset_skill_delete" | "asset_skill_toggle" | "automations_create" |
  "automations_delete" | "automations_list" | "automations_preview" | "automations_run_now" | "automations_toggle" | "automations_update" |
  "bash_abort" | "bash_complete" | "bash_exec" | "branch_session" | "browser_input" | "browser_mirror_select" |
  "browser_mirror_subscribe" | "browser_mirror_unsubscribe" | "btw_ask" | "btw_cancel" | "btw_history" | "btw_promote" |
  "cancel_bg_job" | "collab_join" | "collab_leave" | "collab_start" | "collab_state" | "compact_session" | "complete_text" | "control_subagent" | "create_session" | "cycle_model" |
  "delete_mcp_server" | "delete_session" | "drop_queued" | "fork_session" | "get_all_providers" | "get_bg_jobs" |
  "get_capabilities" | "get_capability_keys" | "get_context_detail" | "get_entry_tree" | "get_file_diff" | "get_git_branches" |
  "get_git_diff" | "git_commit_detail" | "git_commit_file_diff" | "git_graph" | "get_keepalive_status" | "get_limits" | "get_messages" | "get_model_roles" | "get_models_catalog" |
  "get_provider_limits" | "get_search_availability" | "get_session_tree" | "get_settings" | "get_settings_schema" | "get_todos" |
  "get_usage_stats" | "git_commit" | "git_discard" | "git_push" | "git_stage" | "git_unstage" |
  "kill_subagent" | "list_agent_assets" | "list_commands" | "list_dir" | "list_displays" | "list_editors" |
  "list_extensions" | "list_files" | "list_sessions" | "load_session" | "login_prompt_reply" | "mark_seen" |
  "mcp_detach" | "memory_file_read" | "navigate_tree" | "open_folder" | "open_models_config" | "open_screen_recording_settings" |
  "open_with" | "peek_queued" | "preload_mcp" | "probe_provider_models" | "prompt" | "provider_disable_account" |
  "provider_enable_account" | "provider_list_accounts" | "provider_login" | "provider_login_cancel" | "provider_logout" | "provider_model_meta" |
  "provider_reorder_account" | "provider_set_key" | "read_file" | "read_image" | "reload_session" | "reload_settings" |
  "remove_project" | "rename_session" | "reorder_projects" | "reorder_queued" | "requeue" | "remote_regenerate_key" | "save_mcp_server" | "save_provider_model" |
  "save_provider_models" | "search_session_text" | "send_now" | "session_unload" | "set_acp_config" | "set_acp_enabled" |
  "set_approval_mode" | "set_computer_default" | "set_computer_mode" | "set_computer_provider" | "set_desktop_env" |
  "set_enabled_model" | "set_external_browser" |
  "set_hooks_enabled" | "set_keepalive_config" | "set_keepalive_enabled" | "set_kimi_auto_thinking" | "set_locale" | "set_mcp_server_enabled" |
  "set_model" | "set_model_role" | "set_plan_mode" | "set_plugins_enabled" | "set_project_expanded" | "set_remote_config" | "set_session_context_enabled" |
  "set_session_pinned" | "set_setting" | "set_skills_enabled" | "set_thinking" | "set_ui_prefs" | "smoke_plan_propose" |
  "ssh_list_dirs" | "ssh_list_hosts" | "ssh_remove_host" | "ssh_save_host" | "ssh_test_host" | "stt_download" |
  "stt_start" | "stt_stop" | "switch_git_branch" | "switch_profile" | "terminal_create" | "terminal_dispose" |
  "terminal_resize" | "terminal_write" | "test_kimi_cu" | "test_mcp_server" | "test_provider_model" | "toggle_extension_item" |
  "toggle_extension_provider" | "toggle_extension_user_source" | "ui_error" | "voice_status" |
  "worktree_create" | "worktree_remove" | "worktree_status";

/**
 * Typed request members (payload-checked). Grows one member per migrated
 * method; see the {@link HostRequestMethod} doc comment for the process.
 */
export type RpcRequest = {
  type: "set_locale";
  lang: "zh-CN" | "en";
};

/** Escape hatch that keeps the payload unchecked but the method name honest. */
export type LooseHostRequest = { type: HostRequestMethod } & Record<string, unknown>;

/** Anything the UI sends to the host over the WS (the `send` slice parameter). */
export type HostRequest = RpcRequest | LooseHostRequest;
