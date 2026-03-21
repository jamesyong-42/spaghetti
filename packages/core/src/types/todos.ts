/**
 * TypeScript interfaces for ~/.claude/todos/
 */

import type { TodoItem } from './projects.js';

export interface TodoFile {
  sessionId: string;
  agentId: string;
  items: TodoItem[];
}
