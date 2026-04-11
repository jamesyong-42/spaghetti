/**
 * Views barrel export
 */

export { Shell } from './shell.js';
export type { ShellProps } from './shell.js';
export type { ViewEntry, ViewNav, ViewContext, ViewType } from './types.js';
export { ViewNavProvider, useViewNav } from './context.js';
export { useListNavigation, useTerminalSize } from './hooks.js';
export { Header, Footer, HRule } from './chrome.js';
export { TabBar } from './tab-bar.js';
export type { TabBarProps } from './tab-bar.js';
export { SearchInput } from './search-input.js';
export type { SearchInputProps } from './search-input.js';
export { Wordmark } from './wordmark.js';
export { BootView } from './boot-view.js';
export type { BootViewProps } from './boot-view.js';
export { WelcomePanel } from './welcome-panel.js';
export type { WelcomePanelProps, WelcomePanelStats } from './welcome-panel.js';
export { MenuView } from './menu-view.js';
export { ProjectsView } from './projects-view.js';
export { ProjectTabView } from './project-tab-view.js';
export type { ProjectTabViewProps } from './project-tab-view.js';
export { SessionsView } from './sessions-view.js';
export { SessionTabView } from './session-tab-view.js';
export type { SessionTabViewProps } from './session-tab-view.js';
export { MessagesView } from './messages-view.js';
export { DetailView } from './detail-view.js';
export { SearchView } from './search-view.js';
export type { SearchViewProps } from './search-view.js';
export { HelpView } from './help-view.js';
export { DoctorView } from './doctor-view.js';
export { StatsView } from './stats-view.js';
export {
  buildDisplayItems,
  applyDisplayFilters,
  createDefaultFilters,
  FILTER_CATEGORIES,
  TOOL_CATEGORIES,
  getToolCategory,
  TOOL_CATEGORY_COLORS,
  toolInputSummary,
  toolResultSummary,
} from './display-items.js';
export type { DisplayItem, FilterState, ToolCategory, FilterCategory } from './display-items.js';
