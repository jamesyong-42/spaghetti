/**
 * @spaghetti/ui — React components for browsing Claude Code agent data
 */

// Context
export { SpaghettiProvider, useSpaghettiAPI, type SpaghettiProviderProps } from './context.js';

// Main playground component
export { AgentDataPlayground } from './AgentDataPlayground.js';

// Individual components
export { ProjectCard } from './components/ProjectCard.js';
export { SessionCard } from './components/SessionCard.js';
export { MessageEntry, buildMessageContext, isToolResultOnlyMessage } from './components/MessageEntry.js';
export type { MessageContext, SubagentInfo } from './components/MessageEntry.js';
export { DetailOverlay } from './components/DetailOverlay.js';
export { MetaRow } from './components/MetaRow.js';
export { Badge } from './components/Badge.js';

// Utilities
export { formatTokenCount, formatRelativeTime, formatDuration, formatBytes } from './utils/formatters.js';

// Live hooks (RFC 005 C3.5)
export {
  useLiveSessionMessages,
  type UseLiveSessionMessagesResult,
  useLiveSessionList,
  useLiveSettings,
  useLiveChanges,
} from './live/index.js';
