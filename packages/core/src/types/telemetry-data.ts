/**
 * TypeScript interfaces for ~/.claude/telemetry/
 */

export type TelemetryEventName =
  | "tengu_claudeai_mcp_eligibility"
  | "tengu_config_cache_stats"
  | "tengu_context_size"
  | "tengu_continue"
  | "tengu_dir_search"
  | "tengu_exit"
  | "tengu_file_history_snapshot_success"
  | "tengu_init"
  | "tengu_input_command"
  | "tengu_mcp_cli_status"
  | "tengu_mcp_ide_server_connection_failed"
  | "tengu_mcp_ide_server_connection_succeeded"
  | "tengu_mcp_server_connection_failed"
  | "tengu_mcp_server_connection_succeeded"
  | "tengu_mcp_servers"
  | "tengu_node_warning"
  | "tengu_notification_method_used"
  | "tengu_paste_text"
  | "tengu_prompt_suggestion_init"
  | "tengu_repl_hook_finished"
  | "tengu_ripgrep_availability"
  | "tengu_run_hook"
  | "tengu_session_forked_branches_fetched"
  | "tengu_shell_set_cwd"
  | "tengu_startup_manual_model_config"
  | "tengu_startup_telemetry"
  | "tengu_status_line_mount"
  | "tengu_timer"
  | "tengu_trust_dialog_shown"
  | "tengu_native_auto_updater_fail"
  | "tengu_native_auto_updater_start"
  | "tengu_version_check_failure";

export interface TelemetryEnv {
  platform: string;
  node_version: string;
  terminal: string;
  package_managers: string;
  runtimes: string;
  is_running_with_bun: boolean;
  is_ci: boolean;
  is_claubbit: boolean;
  is_github_action: boolean;
  is_claude_code_action: boolean;
  is_claude_ai_auth: boolean;
  version: string;
  arch: string;
  is_claude_code_remote: boolean;
  deployment_environment: string;
  is_conductor: boolean;
  version_base: string;
}

export interface TelemetryEventData {
  event_name: TelemetryEventName;
  client_timestamp: string;
  model: string;
  session_id: string;
  user_type: string;
  betas: string;
  env: TelemetryEnv;
  entrypoint: string;
  is_interactive: boolean;
  client_type: string;
  additional_metadata: string;
  event_id: string;
  device_id: string;
  auth?: string;
  parent_session_id?: string;
  process?: string;
}

export interface TelemetryEvent {
  event_type: "ClaudeCodeInternalEvent";
  event_data: TelemetryEventData;
}

export interface TelemetryFile {
  sessionUuid: string;
  eventUuid: string;
  events: TelemetryEvent[];
  size: number;
}

export interface TelemetryDirectory {
  files: TelemetryFile[];
}
