/**
 * View types — shared type definitions for the TUI view stack
 */

import type React from 'react';
import type { ProjectListItem, SessionListItem } from '@vibecook/spaghetti-core';

// ─── View Types ────────────────────────────────────────────────────────

export type ViewType =
  | 'boot'
  | 'projects'
  | 'sessions'
  | 'messages'
  | 'detail'
  | 'search'
  | 'stats'
  | 'memory'
  | 'todos'
  | 'plan'
  | 'subagents'
  | 'help';

export interface ViewEntry {
  type: ViewType;
  component: React.FC;
  breadcrumb: string;
  hints?: string;
}

// ─── Navigation ────────────────────────────────────────────────────────

export interface ViewNav {
  push(view: ViewEntry): void;
  pop(): void;
  replace(view: ViewEntry): void;
  /** Pop the current view and push multiple views in a single state update (for search→navigate) */
  popAndPush(...views: ViewEntry[]): void;
  quit(): void;
  enterCommandMode(): void;
  context: ViewContext;
  /** True when the command input overlay is active — views should suppress their key handling */
  commandMode: boolean;
  /** Set a subtitle line shown between breadcrumb and HRule (e.g. filter chips). Pass null to clear. */
  setSubtitle(subtitle: string | null): void;
}

export interface ViewContext {
  project?: ProjectListItem;
  session?: SessionListItem;
  sessionIndex?: number;
}
