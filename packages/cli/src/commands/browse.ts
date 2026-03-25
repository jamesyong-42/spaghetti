/**
 * Browse command — interactive hierarchical browser
 *
 * Navigates: PROJECTS → SESSIONS → MESSAGES → MESSAGE DETAIL
 * Uses tui.ts for terminal control and interactive-list.ts for list views.
 */

import type {
  SpaghettiAPI,
  ProjectListItem,
  SessionListItem,
  SessionMessage,
  MessagePage,
} from '@vibecook/spaghetti-core';
import { createTUI, TUINotAvailableError } from '../lib/tui.js';
import type { TUI, KeyEvent } from '../lib/tui.js';
import { createListView } from '../lib/interactive-list.js';
import type { ListView } from '../lib/interactive-list.js';
import { theme } from '../lib/color.js';
import {
  formatTokens,
  formatRelativeTime,
  formatNumber,
  formatDuration,
  totalTokens,
} from '../lib/format.js';
import { renderMessage, filterDisplayableMessages } from '../lib/message-render.js';
import cliTruncate from 'cli-truncate';
import pc from 'picocolors';

// ─── Types ──────────────────────────────────────────────────────────────

type ViewLevel = 'projects' | 'sessions' | 'messages' | 'detail';

interface ViewState {
  level: ViewLevel;
  project?: ProjectListItem;
  session?: SessionListItem;
  message?: SessionMessage;
  projectIndex: number;
  sessionIndex: number;
  messageIndex: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const LOAD_MORE_THRESHOLD = 5;
const SEPARATOR = (cols: number) => pc.dim('─'.repeat(cols));

// ─── Main Entry Point ───────────────────────────────────────────────────

export async function browseCommand(api: SpaghettiAPI): Promise<void> {
  const tui = createTUI(); // throws TUINotAvailableError if not possible

  const state: ViewState = {
    level: 'projects',
    projectIndex: 0,
    sessionIndex: 0,
    messageIndex: 0,
  };

  let projects: ProjectListItem[] = [];
  let sessions: SessionListItem[] = [];
  let messages: SessionMessage[] = [];
  let messagePage: MessagePage | null = null;
  let projectFirstPrompts: Map<string, string> = new Map();

  let projectList: ListView<ProjectListItem> | null = null;
  let sessionList: ListView<SessionListItem> | null = null;
  let messageList: ListView<SessionMessage> | null = null;

  let detailLines: string[] = [];
  let detailScrollOffset = 0;

  // ─── Data Fetching ──────────────────────────────────────────────────

  function loadProjects(): void {
    projects = api.getProjectList();
    projects.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    );
    projectFirstPrompts = new Map();
    for (const p of projects) {
      const sess = api.getSessionList(p.slug);
      if (sess.length > 0) {
        projectFirstPrompts.set(p.slug, sess[0].firstPrompt || '');
      }
    }
  }

  function loadSessions(project: ProjectListItem): void {
    sessions = api.getSessionList(project.slug);
  }

  function loadMessages(project: ProjectListItem, session: SessionListItem): void {
    messagePage = api.getSessionMessages(project.slug, session.sessionId, PAGE_SIZE, 0);
    messages = filterDisplayableMessages(messagePage.messages);
  }

  function loadMoreMessages(): void {
    if (!messagePage || !messagePage.hasMore || !state.project || !state.session) return;
    const nextPage = api.getSessionMessages(
      state.project.slug,
      state.session.sessionId,
      PAGE_SIZE,
      messagePage.offset + messagePage.messages.length,
    );
    messagePage = {
      messages: [...messagePage.messages, ...nextPage.messages],
      total: nextPage.total,
      offset: 0,
      hasMore: nextPage.hasMore,
    };
    messages = filterDisplayableMessages(messagePage.messages);
    if (messageList) {
      messageList.updateItems(messages);
    }
  }

  // ─── Renderers ──────────────────────────────────────────────────────

  function renderProjectItem(
    p: ProjectListItem,
    _idx: number,
    selected: boolean,
  ): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.cyan('▎') : ' ';
    const bg = selected ? pc.bold : (s: string) => pc.dim(s);
    const accent = selected ? pc.cyan : pc.dim;

    const name = bg(p.folderName);
    const branch = accent(p.latestGitBranch || '');
    const prompt = projectFirstPrompts.get(p.slug) || '';
    const promptLine = accent(
      cliTruncate(`"${prompt}"`, Math.max(cols - 6, 20)),
    );
    const stats = accent(
      `${formatNumber(p.sessionCount)} sessions  ·  ${formatNumber(p.messageCount)} msgs  ·  ${formatTokens(totalTokens(p.tokenUsage))} tokens  ·  ${formatRelativeTime(p.lastActiveAt)}`,
    );

    return [
      `${prefix} ${name}  ${branch}`,
      `${prefix} ${promptLine}`,
      `${prefix} ${stats}`,
    ];
  }

  function renderSessionItem(
    s: SessionListItem,
    idx: number,
    selected: boolean,
  ): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.yellow('▎') : ' ';
    const bg = selected ? pc.bold : (s: string) => pc.dim(s);
    const accent = selected ? pc.yellow : pc.dim;

    const num = bg(`#${idx + 1}`);
    const branch = accent(s.gitBranch || '');
    const prompt = s.firstPrompt || '';
    const promptLine = accent(
      cliTruncate(`"${prompt}"`, Math.max(cols - 6, 20)),
    );
    const stats = accent(
      `${formatNumber(s.messageCount)} msgs  ·  ${formatTokens(totalTokens(s.tokenUsage))} tokens  ·  ${formatDuration(s.lifespanMs)}  ·  ${formatRelativeTime(s.lastUpdate)}`,
    );

    return [
      `${prefix} ${num}  ${branch}`,
      `${prefix} ${promptLine}`,
      `${prefix} ${stats}`,
    ];
  }

  function renderMessageItem(
    msg: SessionMessage,
    _idx: number,
    selected: boolean,
  ): string[] {
    const cols = tui.cols;
    const prefix = selected ? pc.green('▎') : ' ';
    const accent = selected ? pc.green : pc.dim;

    let roleStyled = accent(msg.type);
    if (msg.type === 'user') roleStyled = selected ? pc.green(pc.bold('user')) : pc.dim('user');
    if (msg.type === 'assistant')
      roleStyled = selected ? pc.green(pc.bold('assistant')) : pc.dim('assistant');

    // timestamp may not exist on all message types (e.g. SummaryMessage)
    const timestamp =
      'timestamp' in msg && (msg as any).timestamp
        ? accent(formatRelativeTime((msg as any).timestamp))
        : '';

    let preview = '';
    if (msg.type === 'user') {
      const content = (msg as any).message.content;
      if (typeof content === 'string') preview = content;
      else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b.type === 'text');
        if (textBlock && 'text' in textBlock) preview = textBlock.text;
      }
    } else if (msg.type === 'assistant') {
      const blocks = (msg as any).message.content || [];
      const textBlocks = blocks.filter((b: any) => b.type === 'text');
      preview = textBlocks.map((b: any) => b.text).join(' ');
    } else if (msg.type === 'system') {
      preview = '[system]';
    }
    preview = preview.replace(/\n/g, ' ');
    const previewLine = accent(cliTruncate(preview, Math.max(cols - 6, 20)));

    return [
      `${prefix} ${roleStyled}  ${timestamp}`,
      `${prefix} ${previewLine}`,
    ];
  }

  // ─── Header / Footer Builders ───────────────────────────────────────

  function buildHeader(): string[] {
    const cols = tui.cols;
    let breadcrumb = '';

    switch (state.level) {
      case 'projects':
        breadcrumb = theme.project(`Projects`) + pc.dim(` (${projects.length})`);
        break;
      case 'sessions':
        breadcrumb =
          pc.dim(state.project!.folderName) +
          pc.dim(' › ') +
          theme.session(`Sessions`) +
          pc.dim(` (${sessions.length})`);
        break;
      case 'messages':
        breadcrumb =
          pc.dim(state.project!.folderName) +
          pc.dim(' › ') +
          pc.dim(`#${state.sessionIndex + 1}`) +
          pc.dim(' › ') +
          theme.message(`Messages`) +
          pc.dim(` (${messagePage?.total ?? messages.length})`);
        break;
      case 'detail': {
        const role = state.message?.type || '';
        const ts =
          state.message && 'timestamp' in state.message && (state.message as any).timestamp
            ? formatRelativeTime((state.message as any).timestamp)
            : '';
        breadcrumb =
          pc.dim(state.project!.folderName) +
          pc.dim(' › ') +
          pc.dim(`#${state.sessionIndex + 1}`) +
          pc.dim(' › ') +
          theme.detail(`Message ${state.messageIndex + 1}`) +
          pc.dim(` ${role} · ${ts}`);
        break;
      }
    }

    return [
      `  ${breadcrumb}`,
      `  ${SEPARATOR(cols - 4)}`,
    ];
  }

  function buildFooter(): string[] {
    const cols = tui.cols;
    let hints = '';

    switch (state.level) {
      case 'projects':
        hints = '↑↓ navigate  Enter open  q quit';
        break;
      case 'sessions':
      case 'messages':
        hints = '↑↓ navigate  Enter open  Esc back  q quit';
        break;
      case 'detail':
        hints = `↑↓ scroll  Esc back  q quit  [${detailScrollOffset + 1} / ${detailLines.length} lines]`;
        break;
    }

    return [
      `  ${SEPARATOR(cols - 4)}`,
      `  ${pc.dim(hints)}`,
    ];
  }

  // ─── View Setup ─────────────────────────────────────────────────────

  function setupProjectsView(): void {
    loadProjects();
    if (projects.length === 0) {
      tui.cleanup();
      throw new TUINotAvailableError('no projects found');
    }
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    projectList = createListView({
      items: projects,
      renderItem: renderProjectItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (projectList.getSelectedIndex() < state.projectIndex && state.projectIndex < projects.length) {
      projectList.moveDown();
    }
  }

  function setupSessionsView(): void {
    loadSessions(state.project!);
    if (sessions.length === 0) {
      // Show empty state — render a centered message
      state.level = 'sessions';
      const header = buildHeader();
      const footer = buildFooter();
      const viewportHeight = tui.rows - header.length - footer.length;
      const emptyMsg = pc.dim('No sessions found');
      const padTop = Math.floor(viewportHeight / 2);
      const lines = [...header];
      for (let i = 0; i < padTop; i++) lines.push('');
      lines.push(`  ${emptyMsg}`);
      while (lines.length < header.length + viewportHeight) lines.push('');
      lines.push(...footer);
      tui.render(lines);
      sessionList = null;
      return;
    }
    state.level = 'sessions';
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    sessionList = createListView({
      items: sessions,
      renderItem: renderSessionItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (sessionList.getSelectedIndex() < state.sessionIndex && state.sessionIndex < sessions.length) {
      sessionList.moveDown();
    }
  }

  function setupMessagesView(): void {
    loadMessages(state.project!, state.session!);
    if (messages.length === 0) {
      state.level = 'messages';
      const header = buildHeader();
      const footer = buildFooter();
      const viewportHeight = tui.rows - header.length - footer.length;
      const emptyMsg = pc.dim('No messages');
      const padTop = Math.floor(viewportHeight / 2);
      const lines = [...header];
      for (let i = 0; i < padTop; i++) lines.push('');
      lines.push(`  ${emptyMsg}`);
      while (lines.length < header.length + viewportHeight) lines.push('');
      lines.push(...footer);
      tui.render(lines);
      messageList = null;
      return;
    }
    state.level = 'messages';
    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    messageList = createListView({
      items: messages,
      renderItem: renderMessageItem,
      headerLines: header,
      footerLines: footer,
      viewportHeight,
    });

    while (messageList.getSelectedIndex() < state.messageIndex && state.messageIndex < messages.length) {
      messageList.moveDown();
    }
  }

  function setupDetailView(): void {
    state.level = 'detail';
    detailScrollOffset = 0;
    const rendered = renderMessage(state.message!, { width: tui.cols - 4 });
    detailLines = rendered.split('\n');
  }

  // ─── Render ──────────────────────────────────────────────────────────

  // Recreates the list view with fresh header/footer on each render.
  // This is simple and correct. At our data scale (< 50 visible items
  // due to pagination), the O(n) index restoration is negligible.
  function fullRender(): void {
    if (state.level === 'detail') {
      const dh = buildHeader();
      const df = buildFooter();
      const viewportHeight = tui.rows - dh.length - df.length;
      const visible = detailLines.slice(
        detailScrollOffset,
        detailScrollOffset + viewportHeight,
      );
      while (visible.length < viewportHeight) visible.push('');
      tui.render([...dh, ...visible.map((l) => `  ${l}`), ...df]);
      return;
    }

    const header = buildHeader();
    const footer = buildFooter();
    const viewportHeight = tui.rows - header.length - footer.length;

    let activeList: ListView<any> | null = null;
    switch (state.level) {
      case 'projects':
        if (projectList) {
          projectList = createListView({
            items: projects,
            renderItem: renderProjectItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.projectIndex && i < projects.length - 1; i++) {
            projectList.moveDown();
          }
          activeList = projectList;
        }
        break;
      case 'sessions':
        if (sessionList) {
          sessionList = createListView({
            items: sessions,
            renderItem: renderSessionItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.sessionIndex && i < sessions.length - 1; i++) {
            sessionList.moveDown();
          }
          activeList = sessionList;
        }
        break;
      case 'messages':
        if (messageList) {
          messageList = createListView({
            items: messages,
            renderItem: renderMessageItem,
            headerLines: header,
            footerLines: footer,
            viewportHeight,
          });
          for (let i = 0; i < state.messageIndex && i < messages.length - 1; i++) {
            messageList.moveDown();
          }
          activeList = messageList;
        }
        break;
    }

    if (activeList) {
      tui.render(activeList.getLines());
    }
  }

  // ─── Key Handler ────────────────────────────────────────────────────

  function handleKey(key: KeyEvent): void {
    if (key === 'q' || key === 'ctrl-c') {
      tui.cleanup();
      return;
    }

    switch (state.level) {
      case 'projects':
        handleProjectsKey(key);
        break;
      case 'sessions':
        handleSessionsKey(key);
        break;
      case 'messages':
        handleMessagesKey(key);
        break;
      case 'detail':
        handleDetailKey(key);
        break;
    }
  }

  function handleProjectsKey(key: KeyEvent): void {
    if (!projectList || projects.length === 0) {
      if (key === 'escape') tui.cleanup();
      return;
    }

    switch (key) {
      case 'up':
        projectList.moveUp();
        state.projectIndex = projectList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        projectList.moveDown();
        state.projectIndex = projectList.getSelectedIndex();
        fullRender();
        break;
      case 'enter':
        state.project = projectList.getSelected();
        state.projectIndex = projectList.getSelectedIndex();
        state.sessionIndex = 0;
        setupSessionsView();
        fullRender();
        break;
      case 'escape':
        tui.cleanup();
        break;
    }
  }

  function handleSessionsKey(key: KeyEvent): void {
    if (!sessionList) {
      if (key === 'escape') {
        state.level = 'projects';
        setupProjectsView();
        fullRender();
      }
      return;
    }

    switch (key) {
      case 'up':
        sessionList.moveUp();
        state.sessionIndex = sessionList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        sessionList.moveDown();
        state.sessionIndex = sessionList.getSelectedIndex();
        fullRender();
        break;
      case 'enter':
        if (sessions.length === 0) break;
        state.session = sessionList.getSelected();
        state.sessionIndex = sessionList.getSelectedIndex();
        state.messageIndex = 0;
        setupMessagesView();
        fullRender();
        break;
      case 'escape':
        state.level = 'projects';
        setupProjectsView();
        fullRender();
        break;
    }
  }

  function handleMessagesKey(key: KeyEvent): void {
    if (!messageList) {
      if (key === 'escape') {
        state.level = 'sessions';
        setupSessionsView();
        fullRender();
      }
      return;
    }

    switch (key) {
      case 'up':
        messageList.moveUp();
        state.messageIndex = messageList.getSelectedIndex();
        fullRender();
        break;
      case 'down':
        messageList.moveDown();
        state.messageIndex = messageList.getSelectedIndex();
        if (
          messagePage?.hasMore &&
          state.messageIndex >= messages.length - LOAD_MORE_THRESHOLD
        ) {
          loadMoreMessages();
        }
        fullRender();
        break;
      case 'enter':
        if (messages.length === 0) break;
        state.message = messageList.getSelected();
        state.messageIndex = messageList.getSelectedIndex();
        setupDetailView();
        fullRender();
        break;
      case 'escape':
        state.level = 'sessions';
        setupSessionsView();
        fullRender();
        break;
    }
  }

  function handleDetailKey(key: KeyEvent): void {
    const viewportHeight = tui.rows - 4; // header + footer

    switch (key) {
      case 'up':
        if (detailScrollOffset > 0) {
          detailScrollOffset--;
          fullRender();
        }
        break;
      case 'down':
        if (detailScrollOffset < detailLines.length - viewportHeight) {
          detailScrollOffset++;
          fullRender();
        }
        break;
      case 'escape':
        state.level = 'messages';
        setupMessagesView();
        fullRender();
        break;
    }
  }

  // ─── Run ────────────────────────────────────────────────────────────

  try {
    state.level = 'projects';
    setupProjectsView();
    fullRender();

    tui.onKey(handleKey);
    tui.onResize(() => fullRender());

    // Keep the process alive until cleanup is called
    await new Promise<void>((resolve) => {
      const origCleanup = tui.cleanup.bind(tui);
      tui.cleanup = () => {
        origCleanup();
        resolve();
      };
    });
  } catch (err) {
    tui.cleanup();
    throw err;
  }
}
