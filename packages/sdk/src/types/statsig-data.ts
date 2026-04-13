/**
 * TypeScript interfaces for ~/.claude/statsig/
 */

export interface StatsigFeatureGate {
  name: string;
  value: boolean;
  rule_id: string;
  id_type: string;
  secondary_exposures: unknown[];
}

export interface StatsigDynamicConfig {
  name: string;
  value: Record<string, unknown>;
  rule_id: string;
  group: string;
  group_name?: string;
  is_device_based: boolean;
  passed?: boolean;
  id_type: string;
  is_experiment_active?: boolean;
  secondary_exposures: unknown[];
}

export interface StatsigAutoCaptureSettings {
  disabled_events: Record<string, unknown>;
}

export interface StatsigEvaluationsData {
  feature_gates: Record<string, StatsigFeatureGate>;
  dynamic_configs: Record<string, StatsigDynamicConfig>;
  layer_configs: Record<string, unknown>;
  sdkParams: Record<string, unknown>;
  has_updates: boolean;
  generator: string;
  time: number;
  company_lcut: number;
  evaluated_keys: Record<string, string>;
  hash_used: string;
  derived_fields: Record<string, string>;
  hashed_sdk_key_used: string;
  can_record_session: boolean;
  recording_blocked: boolean;
  session_recording_rate: number;
  auto_capture_settings: StatsigAutoCaptureSettings;
  target_app_used: string;
  full_checksum: string;
}

export interface StatsigCachedEvaluations {
  source: string;
  data: string;
  receivedAt: number;
  stableID: string;
  fullUserHash: string;
}

export interface StatsigCustomIDs {
  sessionId: string;
  organizationUUID: string;
  accountUUID: string;
}

export interface StatsigUserCustom {
  userType: string;
  organizationUuid: string;
  accountUuid: string;
  subscriptionType: string;
  firstTokenTime: number;
}

export interface StatsigUser {
  customIDs: StatsigCustomIDs;
  userID: string;
  appVersion: string;
  custom: StatsigUserCustom;
  statsigEnvironment: {
    tier: string;
  };
}

export interface StatsigFailedLogMetadata {
  [key: string]: string;
}

export interface StatsigFailedLogEvent {
  eventName: string;
  metadata: StatsigFailedLogMetadata;
  user: StatsigUser;
  time: number;
}

export type StatsigFailedLogs = StatsigFailedLogEvent[];

export type StatsigLastModifiedTime = Record<string, number>;

export interface StatsigSessionId {
  sessionID: string;
  startTime: number;
  lastUpdate: number;
}

export type StatsigStableId = string;

export interface StatsigDirectory {
  cachedEvaluations?: StatsigCachedEvaluations;
  failedLogs?: StatsigFailedLogs;
  lastModifiedTime?: StatsigLastModifiedTime;
  sessionId?: StatsigSessionId;
  stableId?: StatsigStableId;
}
