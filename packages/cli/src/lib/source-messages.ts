/**
 * Adapt raw stored message records into a Claude-shaped SessionMessage for
 * terminal rendering. Codex stores RolloutLine JSON in `messages.data`; the
 * TUI/CLI renderers expect Anthropic-style `{ type, message: { content } }`.
 */

import type { SessionMessage } from '@vibecook/spaghetti-sdk';

function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

/**
 * Map one raw DB message into a shape the existing Claude message renderer
 * understands. Unknown / non-chat Codex lines become null (skip).
 */
export function adaptMessageForDisplay(raw: unknown, sourceId: string): SessionMessage | null {
  if (!raw || typeof raw !== 'object') return null;

  if (sourceId !== 'codex') {
    return raw as SessionMessage;
  }

  const line = raw as Record<string, unknown>;
  // Codex chat turns only. Non-message rollout lines (session_meta, event_msg,
  // function_call, …) are not displayable as transcript rows — skip them.
  if (line.type !== 'response_item') return null;

  const payload = line.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'message') return null;
  const role = typeof payload.role === 'string' ? payload.role : 'unknown';
  const text = codexContentText(payload.content);
  if (role === 'user' || role === 'developer') {
    return {
      type: 'user',
      uuid: typeof payload.id === 'string' ? payload.id : '',
      parentUuid: null,
      timestamp: typeof line.timestamp === 'string' ? line.timestamp : '',
      sessionId: '',
      cwd: '',
      version: '',
      gitBranch: '',
      isSidechain: false,
      userType: 'external',
      message: { role: 'user', content: text },
    } as SessionMessage;
  }
  if (role === 'assistant') {
    return {
      type: 'assistant',
      uuid: typeof payload.id === 'string' ? payload.id : '',
      parentUuid: null,
      timestamp: typeof line.timestamp === 'string' ? line.timestamp : '',
      sessionId: '',
      cwd: '',
      version: '',
      gitBranch: '',
      isSidechain: false,
      userType: 'external',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    } as SessionMessage;
  }
  // system / other → thin system line
  return {
    type: 'system',
    uuid: typeof payload.id === 'string' ? payload.id : '',
    parentUuid: null,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : '',
    sessionId: '',
    cwd: '',
    version: '',
    gitBranch: '',
    isSidechain: false,
    userType: 'external',
    content: text || role,
    level: 'info',
  } as SessionMessage;
}

export function adaptMessagesForDisplay(raw: unknown[], sourceId: string): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const m of raw) {
    const adapted = adaptMessageForDisplay(m, sourceId);
    if (adapted) out.push(adapted);
  }
  return out;
}
