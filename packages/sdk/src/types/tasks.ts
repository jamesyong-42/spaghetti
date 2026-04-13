/**
 * TypeScript interfaces for ~/.claude/tasks/
 */

export interface TaskEntry {
  taskId: string;
  hasHighwatermark: boolean;
  highwatermark: number | null;
  lockExists: boolean;
  items?: TaskItem[];
}

/** Individual task item stored as {N}.json in the task directory */
export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
}

export interface TaskDirectory {
  tasks: TaskEntry[];
}
