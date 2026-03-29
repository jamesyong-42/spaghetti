/**
 * Search Indexer — Extracts searchable text + tags from segment data
 */

import type { SegmentType } from './segment-types.js';

export interface SearchIndexEntry {
  projectSlug?: string;
  sessionId?: string;
  textContent: string;
  tags: string[];
}

export interface SearchIndexer {
  extractSearchEntry(
    type: SegmentType,
    data: unknown,
    context?: { projectSlug?: string; sessionId?: string },
  ): SearchIndexEntry | null;
}

const MAX_TEXT_LENGTH = 2_000;

class SearchIndexerImpl implements SearchIndexer {
  extractSearchEntry(
    type: SegmentType,
    data: unknown,
    context?: { projectSlug?: string; sessionId?: string },
  ): SearchIndexEntry | null {
    const base = { projectSlug: context?.projectSlug, sessionId: context?.sessionId };

    switch (type) {
      case 'message':
        return this.extractMessage(data, base);
      case 'session':
        return this.extractSession(data, base);
      case 'project_memory':
        return this.extractProjectMemory(data, base);
      case 'subagent':
        return this.extractSubagent(data, base);
      case 'tool_result':
        return this.extractToolResult(data, base);
      case 'plan':
        return this.extractPlan(data, base);
      case 'todo':
        return this.extractTodo(data, base);
      case 'analytics_history':
        return this.extractAnalyticsHistory(data, base);
      default:
        return null;
    }
  }

  private extractMessage(data: unknown, base: { projectSlug?: string; sessionId?: string }): SearchIndexEntry | null {
    const msg = data as Record<string, unknown>;
    const tags: string[] = [];
    const textParts: string[] = [];
    const msgType = msg.type as string | undefined;

    if (msgType === 'user') {
      tags.push('type:user');
      const message = msg.message as Record<string, unknown> | undefined;
      if (message) {
        const content = message.content;
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
            else if (b.type === 'tool_result') {
              const rc = b.content;
              if (typeof rc === 'string') textParts.push(rc);
              else if (Array.isArray(rc)) {
                for (const r of rc) {
                  const rb = r as Record<string, unknown>;
                  if (rb.type === 'text' && typeof rb.text === 'string') textParts.push(rb.text);
                }
              }
            }
          }
        }
      }
    } else if (msgType === 'assistant') {
      tags.push('type:assistant');
      const message = msg.message as Record<string, unknown> | undefined;
      if (message) {
        const model = message.model as string | undefined;
        if (model) tags.push(`model:${model}`);
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
            else if (b.type === 'tool_use') {
              const toolName = b.name as string | undefined;
              if (toolName) tags.push(`tool:${toolName}`);
            }
          }
        }
      }
    } else {
      return null;
    }

    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags };
  }

  private extractSession(data: unknown, base: { projectSlug?: string; sessionId?: string }): SearchIndexEntry | null {
    const session = data as Record<string, unknown>;
    const textParts: string[] = [];
    const indexEntry = session.indexEntry as Record<string, unknown> | undefined;
    if (indexEntry) {
      if (typeof indexEntry.firstPrompt === 'string') textParts.push(indexEntry.firstPrompt);
      if (typeof indexEntry.summary === 'string') textParts.push(indexEntry.summary);
    }
    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags: [] };
  }

  private extractProjectMemory(
    data: unknown,
    base: { projectSlug?: string; sessionId?: string },
  ): SearchIndexEntry | null {
    const memory = data as Record<string, unknown>;
    const content = memory.content;
    if (typeof content !== 'string' || !content) return null;
    return { ...base, textContent: truncate(content), tags: ['memory'] };
  }

  private extractSubagent(data: unknown, base: { projectSlug?: string; sessionId?: string }): SearchIndexEntry | null {
    const subagent = data as Record<string, unknown>;
    const tags: string[] = ['subagent'];
    const textParts: string[] = [];
    const agentType = subagent.agentType as string | undefined;
    if (agentType) tags.push(`subagent:${agentType}`);
    const messages = subagent.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        const message = m.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const content = message.content;
        if (typeof content === 'string') textParts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
          }
        }
      }
    }
    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags };
  }

  private extractToolResult(
    data: unknown,
    base: { projectSlug?: string; sessionId?: string },
  ): SearchIndexEntry | null {
    const result = data as Record<string, unknown>;
    const content = result.content;
    if (typeof content !== 'string' || !content) return null;
    return { ...base, textContent: truncate(content), tags: ['tool_result'] };
  }

  private extractPlan(data: unknown, base: { projectSlug?: string; sessionId?: string }): SearchIndexEntry | null {
    const plan = data as Record<string, unknown>;
    const textParts: string[] = [];
    if (typeof plan.title === 'string') textParts.push(plan.title);
    if (typeof plan.content === 'string') textParts.push(plan.content);
    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags: ['plan'] };
  }

  private extractTodo(data: unknown, base: { projectSlug?: string; sessionId?: string }): SearchIndexEntry | null {
    const todo = data as Record<string, unknown>;
    const textParts: string[] = [];
    const items = todo.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        const i = item as Record<string, unknown>;
        if (typeof i.content === 'string') textParts.push(i.content);
      }
    }
    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags: ['todo'] };
  }

  private extractAnalyticsHistory(
    data: unknown,
    base: { projectSlug?: string; sessionId?: string },
  ): SearchIndexEntry | null {
    const history = data as Record<string, unknown>;
    const textParts: string[] = [];
    const entries = history.entries;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        if (typeof e.display === 'string') textParts.push(e.display);
      }
    }
    const textContent = textParts.join('\n');
    if (!textContent) return null;
    return { ...base, textContent: truncate(textContent), tags: ['history'] };
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.substring(0, MAX_TEXT_LENGTH);
}

export function createSearchIndexer(): SearchIndexer {
  return new SearchIndexerImpl();
}
