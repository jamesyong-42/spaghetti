/**
 * TypeScript interfaces for data structures found in:
 *   ~/.claude/teams/
 */

// Team configuration (config.json in each team directory)
export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: TeamMember[];
}

export interface TeamMember {
  agentId: string;
  name: string;
  agentType?: string;
  model: string;
  prompt?: string;
  color?: string;
  planModeRequired?: boolean;
  joinedAt: number;
  tmuxPaneId: string;
  cwd: string;
  subscriptions: string[];
  backendType?: string;
}

// Inbox messages (inboxes/*.json files)
export interface InboxMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

// Task assignment payload (embedded in inbox message text as JSON)
export interface TaskAssignmentPayload {
  type: 'task_assignment';
  taskId: string;
  subject: string;
  description: string;
  assignedBy: string;
  timestamp: string;
}

// Top-level team directory entry
export interface TeamDirectory {
  teamId: string;
  config: TeamConfig | null;
  inboxes: Record<string, InboxMessage[]>;
}
