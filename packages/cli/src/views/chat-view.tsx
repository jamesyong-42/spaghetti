/**
 * ChatView — Interactive chat with active Claude Code channel sessions
 *
 * Connects to every live channel MCP server via ChannelManager, shows a
 * message transcript with left/right bubbles, and exposes an input bar
 * at the bottom. Supports:
 *  - ←/→ to cycle between active sessions (wrap-around)
 *  - ↑/↓ to scroll history (disables auto-scroll until back at bottom)
 *  - Enter to send the input buffer as a chat message
 *  - Inline permission approvals: typing `y <id>` or `n <id>` and pressing
 *    Enter dispatches a permission verdict to the current session
 *  - Esc to leave the view
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  createChannelManager,
  type ChannelManager,
  type ChannelMessage,
  type ChannelIncoming,
  type SessionInfo,
  type MessageEcho,
  type ReplyMessage,
  type EditMessage,
  type PermissionRequestMessage,
  type StatusMessage,
} from '@vibecook/spaghetti-core';
import { useViewNav } from './context.js';
import { useTerminalSize } from './hooks.js';
import { Header, HRule } from './chrome.js';
import pc from 'picocolors';

// ─── Constants ───────────────────────────────────────────────────────────

const PERMISSION_VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const HISTORY_LIMIT = 100;
const STATUS_POLL_MS = 1_000;

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  // HH:MM — pull from the ISO directly without constructing a Date to avoid
  // timezone surprises in test envs. Fall back to empty on garbage.
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : '';
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const normalized = text.replace(/\r\n/g, '\n');
  const out: string[] = [];
  for (const rawLine of normalized.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    out.push(remaining);
  }
  return out;
}

function shortId(id: string): string {
  return id.slice(0, 4);
}

/** Every incoming message carries a unique key we can use for React lists. */
function messageKey(msg: ChannelMessage, idx: number): string {
  if (msg.type === 'message_echo' || msg.type === 'reply') {
    return `${msg.type}:${msg.id}:${idx}`;
  }
  if (msg.type === 'edit') {
    return `edit:${msg.messageId}:${idx}`;
  }
  if (msg.type === 'permission_request') {
    return `perm:${msg.requestId}:${idx}`;
  }
  if (msg.type === 'status') {
    return `status:${idx}`;
  }
  if (msg.type === 'message') {
    return `message:${msg.id}:${idx}`;
  }
  return `${msg.type}:${idx}`;
}

/** Build a stable de-dupe key so echoes don't double up with local messages. */
function dedupeKey(msg: ChannelMessage): string | null {
  if (msg.type === 'message_echo' || msg.type === 'reply') return `${msg.type}:${msg.id}`;
  if (msg.type === 'edit') return `edit:${msg.messageId}`;
  if (msg.type === 'permission_request') return `perm:${msg.requestId}`;
  return null;
}

function mergeMessages(prev: ChannelMessage[], next: ChannelMessage[]): ChannelMessage[] {
  if (prev.length === 0) return next;
  const seen = new Set<string>();
  for (const m of prev) {
    const k = dedupeKey(m);
    if (k) seen.add(k);
  }
  const out = [...prev];
  for (const m of next) {
    const k = dedupeKey(m);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(m);
  }
  return out;
}

// ─── Types ───────────────────────────────────────────────────────────────

type RenderedLine = { text: string; key: string };

type Slot =
  | { kind: 'line'; line: RenderedLine }
  | { kind: 'permission'; perm: PermissionRequestMessage; key: string; chunk: number; chunkCount: number }
  | { kind: 'blank'; key: string };

// ─── Message Renderers (return plain-string lines) ───────────────────────

function renderUserBubble(msg: MessageEcho, cols: number): RenderedLine[] {
  const maxWidth = Math.max(10, Math.floor(cols * 0.6));
  const wrapped = wrapText(msg.text, maxWidth);
  const time = formatTime(msg.timestamp);
  const lines: RenderedLine[] = [];

  for (let i = 0; i < wrapped.length; i++) {
    const line = wrapped[i];
    const bubbleText = ` ${line} `;
    const padLen = Math.max(0, cols - bubbleText.length - 1);
    const bubble = pc.bgBlue(pc.white(bubbleText));
    lines.push({
      text: `${' '.repeat(padLen)}${bubble} `,
      key: `ub:${msg.id}:${i}`,
    });
  }

  if (time) {
    const tText = time;
    const padLen = Math.max(0, cols - tText.length - 1);
    lines.push({
      text: `${' '.repeat(padLen)}${pc.dim(tText)} `,
      key: `ub:${msg.id}:t`,
    });
  }

  lines.push({ text: '', key: `ub:${msg.id}:gap` });
  return lines;
}

function renderClaudeBubble(msg: ReplyMessage, cols: number): RenderedLine[] {
  const maxWidth = Math.max(10, Math.floor(cols * 0.75));
  const wrapped = wrapText(msg.text, maxWidth);
  const time = formatTime(msg.timestamp);
  const lines: RenderedLine[] = [];

  for (let i = 0; i < wrapped.length; i++) {
    const line = wrapped[i];
    lines.push({
      text: `   ${pc.white(line)}`,
      key: `cb:${msg.id}:${i}`,
    });
  }

  if (time) {
    lines.push({
      text: `   ${pc.dim(time)}`,
      key: `cb:${msg.id}:t`,
    });
  }

  lines.push({ text: '', key: `cb:${msg.id}:gap` });
  return lines;
}

function renderEdit(msg: EditMessage, _cols: number): RenderedLine[] {
  const text = `   ${pc.dim(`\u270E edited \u00B7 ${formatTime(msg.timestamp)}`)}`;
  return [{ text, key: `edit:${msg.messageId}:${msg.timestamp}` }];
}

function renderStatus(msg: StatusMessage): RenderedLine[] {
  const state = msg.connected ? pc.green('\u25CF connected') : pc.red('\u25CF disconnected');
  return [
    {
      text: `   ${pc.dim(state)}`,
      key: `status:${msg.sessionInfo.id}:${msg.connected ? '1' : '0'}`,
    },
  ];
}

// ─── Permission Card (Ink box, rendered separately) ─────────────────────

interface PermissionCardProps {
  perm: PermissionRequestMessage;
  cols: number;
}

function PermissionCard({ perm, cols }: PermissionCardProps): React.ReactElement {
  const cardWidth = Math.min(Math.max(40, Math.floor(cols * 0.8)), cols - 6);
  const shortReq = perm.requestId.slice(0, 5);
  const inputPreview =
    perm.inputPreview.length > cardWidth - 10
      ? perm.inputPreview.slice(0, cardWidth - 11) + '\u2026'
      : perm.inputPreview;

  return (
    <Box paddingLeft={3} paddingRight={3} marginBottom={1}>
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" width={cardWidth} paddingX={1}>
        <Text>
          {pc.yellow(pc.bold('Permission'))} {pc.dim(`[${shortReq}]`)}
        </Text>
        <Text>
          {pc.white(perm.toolName)}
          {perm.description ? pc.dim(`  ${perm.description}`) : ''}
        </Text>
        {inputPreview ? <Text dimColor>{inputPreview}</Text> : null}
        <Text>
          {pc.green(`[y ${shortReq}] allow`)}
          {'   '}
          {pc.red(`[n ${shortReq}] deny`)}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Session Dot Bar ────────────────────────────────────────────────────

interface SessionBarProps {
  sessions: SessionInfo[];
  currentId: string | null;
  unread: Set<string>;
  connectionDot: string;
}

function SessionBar({ sessions, currentId, unread, connectionDot }: SessionBarProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box>
        <Text>
          {' '}
          {connectionDot} {pc.dim('No active sessions')}
        </Text>
      </Box>
    );
  }

  const dots = sessions.map((s) => {
    if (s.id === currentId) return pc.cyan('\u25CF');
    if (unread.has(s.id)) return pc.yellow('\u2022');
    return pc.dim('\u25CB');
  });

  const count = `${sessions.length} active session${sessions.length === 1 ? '' : 's'}`;
  return (
    <Box>
      <Text>
        {' '}
        {connectionDot} {pc.dim(count)} {dots.join(' ')} {pc.dim('\u2190\u2192 switch')}
      </Text>
    </Box>
  );
}

// ─── Flat Message → Lines (memoized at caller) ──────────────────────────

interface FlatItem {
  kind: 'lines' | 'permission';
  lines?: RenderedLine[];
  perm?: PermissionRequestMessage;
  height: number;
  key: string;
}

function flattenMessages(messages: ChannelMessage[], cols: number): FlatItem[] {
  const items: FlatItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const baseKey = messageKey(msg, i);

    if (msg.type === 'message_echo') {
      const lines = renderUserBubble(msg, cols);
      items.push({ kind: 'lines', lines, height: lines.length, key: baseKey });
    } else if (msg.type === 'reply') {
      const lines = renderClaudeBubble(msg, cols);
      items.push({ kind: 'lines', lines, height: lines.length, key: baseKey });
    } else if (msg.type === 'edit') {
      const lines = renderEdit(msg, cols);
      items.push({ kind: 'lines', lines, height: lines.length, key: baseKey });
    } else if (msg.type === 'status') {
      const lines = renderStatus(msg);
      items.push({ kind: 'lines', lines, height: lines.length, key: baseKey });
    } else if (msg.type === 'permission_request') {
      // 4 internal lines + borders (2) + paddingY(0) + marginBottom 1 = 7
      items.push({ kind: 'permission', perm: msg, height: 7, key: baseKey });
    } else if (msg.type === 'message') {
      // Locally-buffered outgoing message before echo arrives — render as
      // a user bubble using the same shape.
      const fake: MessageEcho = {
        type: 'message_echo',
        id: msg.id,
        text: msg.text,
        timestamp: new Date().toISOString(),
        sender: msg.sender,
      };
      const lines = renderUserBubble(fake, cols);
      items.push({ kind: 'lines', lines, height: lines.length, key: baseKey });
    }
    // permission_verdict, ping, pong — silent
  }
  return items;
}

// ─── ChatView ───────────────────────────────────────────────────────────

export function ChatView(): React.ReactElement {
  const nav = useViewNav();
  const { cols, rows } = useTerminalSize();

  // ── Channel manager lifecycle ────────────────────────────────────
  const managerRef = useRef<ChannelManager | null>(null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());

  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Map<string, ChannelMessage[]>>(() => new Map());
  const [unreadBySession, setUnreadBySession] = useState<Set<string>>(() => new Set());
  const [inputBuffer, setInputBuffer] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [currentConnected, setCurrentConnected] = useState(false);

  // Track the latest currentSessionId in a ref so the stable onAnyMessage
  // callback can compare without re-subscribing every time the user switches.
  const currentSessionRef = useRef<string | null>(null);
  useEffect(() => {
    currentSessionRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    let cancelled = false;
    const manager = createChannelManager({ sender: 'tui' });
    managerRef.current = manager;

    const loadHistory = (info: SessionInfo): void => {
      if (loadedHistoryRef.current.has(info.id)) return;
      const client = manager.getClient(info.id);
      if (!client) return;
      loadedHistoryRef.current.add(info.id);
      try {
        const history = client.getHistory(HISTORY_LIMIT);
        if (history.length === 0) return;
        setMessagesBySession((prev) => {
          const next = new Map(prev);
          const existing = next.get(info.id) ?? [];
          next.set(info.id, mergeMessages(history, existing));
          return next;
        });
      } catch {
        // History read errors are non-fatal
      }
    };

    const unsubSessions = manager.onSessionsChanged((nextSessions) => {
      if (cancelled) return;
      setSessions(nextSessions);

      // Pick a current session if we don't have one yet
      setCurrentSessionId((prev) => {
        if (prev && nextSessions.some((s) => s.id === prev)) return prev;
        const first = nextSessions[0]?.id ?? null;
        if (first) manager.setCurrentSession(first);
        return first;
      });

      for (const info of nextSessions) {
        loadHistory(info);
      }
    });

    const unsubMessages = manager.onAnyMessage((sessionId, msg: ChannelIncoming) => {
      if (cancelled) return;
      setMessagesBySession((prev) => {
        const next = new Map(prev);
        const list = next.get(sessionId) ?? [];
        next.set(sessionId, mergeMessages(list, [msg]));
        return next;
      });

      if (currentSessionRef.current !== sessionId) {
        setUnreadBySession((prev) => {
          if (prev.has(sessionId)) return prev;
          const next = new Set(prev);
          next.add(sessionId);
          return next;
        });
      }
    });

    manager
      .start()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        // Pull initial snapshot so we don't have to wait for the watcher.
        const initial = manager.getSessions();
        setSessions(initial);
        setCurrentSessionId((prev) => {
          if (prev && initial.some((s) => s.id === prev)) return prev;
          const first = initial[0]?.id ?? null;
          if (first) manager.setCurrentSession(first);
          return first;
        });
        for (const info of initial) {
          loadHistory(info);
        }
      })
      .catch(() => {
        // Swallow — reconnect loop inside client handles retries
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
      unsubSessions();
      unsubMessages();
      try {
        manager.stop();
      } catch {
        // ignore
      }
      managerRef.current = null;
      loadedHistoryRef.current.clear();
    };
  }, []);

  // ── Poll connected state for the current session ────────────────
  useEffect(() => {
    if (!currentSessionId) {
      setCurrentConnected(false);
      return;
    }
    const manager = managerRef.current;
    if (!manager) return;

    const check = (): void => {
      const client = manager.getClient(currentSessionId);
      setCurrentConnected(client ? client.isConnected() : false);
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [currentSessionId]);

  // ── Derived ──────────────────────────────────────────────────────
  const currentSession = useMemo(
    () => (currentSessionId ? (sessions.find((s) => s.id === currentSessionId) ?? null) : null),
    [sessions, currentSessionId],
  );

  const currentMessages = useMemo<ChannelMessage[]>(
    () => (currentSessionId ? (messagesBySession.get(currentSessionId) ?? []) : []),
    [messagesBySession, currentSessionId],
  );

  const pendingPermissions = useMemo<PermissionRequestMessage[]>(() => {
    return currentMessages.filter((m): m is PermissionRequestMessage => m.type === 'permission_request');
  }, [currentMessages]);

  // Flatten messages into rendered items and line count
  const flatItems = useMemo(() => flattenMessages(currentMessages, cols - 1), [currentMessages, cols]);
  const totalLines = useMemo(() => flatItems.reduce((sum, item) => sum + item.height, 0), [flatItems]);

  // Reserve: 1 header line + 1 session bar + 1 hrule + 1 hrule-before-input + 1 input + 1 footer hrule + 1 footer = ~7
  const viewportHeight = Math.max(6, rows - 8);

  // Auto-scroll effect: when totalLines grows and autoScroll is on, pin to bottom
  const lastTotalLinesRef = useRef(totalLines);
  useEffect(() => {
    if (totalLines !== lastTotalLinesRef.current) {
      lastTotalLinesRef.current = totalLines;
      if (autoScroll) setScrollOffset(0);
    }
  }, [totalLines, autoScroll]);

  // ── Session switching ──────────────────────────────────────────────
  const switchSession = useCallback(
    (direction: 1 | -1) => {
      if (sessions.length === 0) return;
      const manager = managerRef.current;
      if (!manager) return;
      const idx = currentSessionId ? sessions.findIndex((s) => s.id === currentSessionId) : -1;
      const nextIdx = idx < 0 ? 0 : (idx + direction + sessions.length) % sessions.length;
      const nextId = sessions[nextIdx].id;
      setCurrentSessionId(nextId);
      manager.setCurrentSession(nextId);
      setUnreadBySession((prev) => {
        if (!prev.has(nextId)) return prev;
        const next = new Set(prev);
        next.delete(nextId);
        return next;
      });
      setScrollOffset(0);
      setAutoScroll(true);
    },
    [sessions, currentSessionId],
  );

  // ── Submit handler (send or verdict) ───────────────────────────────
  const submitBuffer = useCallback(() => {
    const text = inputBuffer;
    if (text.trim().length === 0) return;
    const manager = managerRef.current;
    if (!manager || !currentSessionId) {
      setInputBuffer('');
      return;
    }
    const client = manager.getClient(currentSessionId);
    if (!client) {
      setInputBuffer('');
      return;
    }

    const match = PERMISSION_VERDICT_RE.exec(text);
    if (match) {
      const verb = match[1].toLowerCase();
      const shortReq = match[2].toLowerCase();
      const behavior: 'allow' | 'deny' = verb.startsWith('y') ? 'allow' : 'deny';
      // Find the full requestId from pending permissions by short prefix.
      const target = pendingPermissions.find((p) => p.requestId.slice(0, 5).toLowerCase() === shortReq);
      if (target) {
        client.sendPermissionVerdict(target.requestId, behavior);
      } else {
        // Unknown short id — fall back to sending the raw text as a message.
        client.sendMessage(text);
      }
    } else {
      client.sendMessage(text);
    }

    setInputBuffer('');
    setAutoScroll(true);
    setScrollOffset(0);
  }, [inputBuffer, currentSessionId, pendingPermissions]);

  // ── Input handling ─────────────────────────────────────────────────
  useInput(
    (input, key) => {
      if (nav.searchMode) return;

      if (key.escape) {
        nav.pop();
        return;
      }

      if (key.leftArrow) {
        switchSession(-1);
        return;
      }
      if (key.rightArrow) {
        switchSession(1);
        return;
      }

      if (key.upArrow) {
        setAutoScroll(false);
        setScrollOffset((prev) => {
          const maxOffset = Math.max(0, totalLines - viewportHeight);
          return Math.min(maxOffset, prev + 1);
        });
        return;
      }
      if (key.downArrow) {
        setScrollOffset((prev) => {
          const next = Math.max(0, prev - 1);
          if (next === 0) setAutoScroll(true);
          return next;
        });
        return;
      }

      if (key.return) {
        submitBuffer();
        return;
      }

      if (key.backspace || key.delete) {
        setInputBuffer((prev) => prev.slice(0, -1));
        return;
      }

      // Printable character — append to buffer. Guard ctrl/meta combos.
      if (input && !key.ctrl && !key.meta && input.length > 0) {
        setInputBuffer((prev) => prev + input);
      }
    },
    { isActive: !nav.searchMode },
  );

  // ── Rendering helpers ──────────────────────────────────────────────

  const connectionDot = useMemo(() => {
    if (!ready) return pc.yellow('\u25CF');
    if (!currentSessionId) return pc.red('\u25CF');
    return currentConnected ? pc.green('\u25CF') : pc.yellow('\u25CF');
  }, [ready, currentSessionId, currentConnected]);

  const breadcrumbLabel = useMemo(() => {
    if (!currentSession) return 'Chat';
    return `Chat \u2014 ${currentSession.projectName} \u00B7 ${shortId(currentSession.id)}`;
  }, [currentSession]);

  // Build visible lines from flatItems with scrollOffset measured from bottom.
  // We render top-down: we need a "window" into flat lines that ends at
  // (totalLines - scrollOffset) and is viewportHeight tall.
  const visibleSlots = useMemo(() => {
    // Expand flatItems into a linear "slot" array first, matching each item's height.
    const allSlots: Slot[] = [];
    for (const item of flatItems) {
      if (item.kind === 'lines' && item.lines) {
        for (const line of item.lines) {
          allSlots.push({ kind: 'line', line });
        }
      } else if (item.kind === 'permission' && item.perm) {
        // Occupies `height` slots; we render the actual <PermissionCard /> on
        // the first slot and leave the rest empty (handled below).
        allSlots.push({
          kind: 'permission',
          perm: item.perm,
          key: item.key,
          chunk: 0,
          chunkCount: item.height,
        });
        for (let j = 1; j < item.height; j++) {
          allSlots.push({ kind: 'blank', key: `${item.key}:pad:${j}` });
        }
      }
    }

    // Pick the window
    const end = Math.max(0, allSlots.length - scrollOffset);
    const start = Math.max(0, end - viewportHeight);
    const windowSlots = allSlots.slice(start, end);

    // Top-pad so the input bar stays pinned at the bottom.
    while (windowSlots.length < viewportHeight) {
      windowSlots.unshift({ kind: 'blank', key: `pad-top:${windowSlots.length}` });
    }

    return windowSlots;
  }, [flatItems, scrollOffset, viewportHeight]);

  // ── Render ────────────────────────────────────────────────────────

  const inputPrompt = pc.cyan('\u276F');

  // Not-ready placeholder
  if (!ready) {
    return (
      <Box flexDirection="column">
        <Header breadcrumb={breadcrumbLabel} />
        <Box paddingLeft={1}>
          <Text dimColor>Connecting to active sessions\u2026</Text>
        </Box>
      </Box>
    );
  }

  // Zero-sessions state (still show input bar so Esc works)
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Header breadcrumb={breadcrumbLabel} />
        <SessionBar sessions={sessions} currentId={null} unread={unreadBySession} connectionDot={connectionDot} />
        <HRule />
        <Box height={viewportHeight} flexDirection="column" paddingLeft={2} paddingTop={2}>
          <Text dimColor>No active Claude Code sessions.</Text>
          <Text dimColor>Start a Claude Code session with the spaghetti-channel plugin installed.</Text>
        </Box>
        <HRule />
        <Box>
          <Text>
            {' '}
            {inputPrompt} {pc.dim('Type a message\u2026')}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header breadcrumb={breadcrumbLabel} />
      <SessionBar
        sessions={sessions}
        currentId={currentSessionId}
        unread={unreadBySession}
        connectionDot={connectionDot}
      />
      <HRule />

      <Box flexDirection="column" height={viewportHeight}>
        {visibleSlots.map((slot, i) => {
          if (slot.kind === 'line') {
            return <Text key={`s:${i}`}>{slot.line.text}</Text>;
          }
          if (slot.kind === 'permission') {
            return <PermissionCard key={`${slot.key}:card`} perm={slot.perm} cols={cols - 1} />;
          }
          return <Text key={slot.key}> </Text>;
        })}
      </Box>

      <HRule />

      {/* Input bar */}
      <Box>
        <Text>
          {' '}
          {inputPrompt}{' '}
          {inputBuffer.length === 0 ? <Text dimColor>Type a message\u2026</Text> : <Text>{inputBuffer}</Text>}
          <Text inverse> </Text>
        </Text>
      </Box>
    </Box>
  );
}
