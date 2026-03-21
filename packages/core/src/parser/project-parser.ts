import * as path from 'node:path';
import type { FileService } from '../io/index.js';
import type {
  Project,
  Session,
  SessionsIndex,
  SessionIndexEntry,
  SessionMessage,
  SubagentTranscript,
  SubagentType,
  PersistedToolResult,
  ProjectMemory,
  FileHistorySession,
  FileHistorySnapshotFile,
  TodoFile,
  TodoItem,
  TaskEntry,
  PlanFile,
} from '../types/index.js';
import type { ProjectParseSink } from './parse-sink.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT PARSER OPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProjectParserOptions {
  skipSessionMessages?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT PARSER INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProjectParser {
  parseAllProjects(claudeDir: string, options?: ProjectParserOptions): Project[];
  parseAllProjectsStreaming(claudeDir: string, sink: ProjectParseSink, options?: ProjectParserOptions): void;
  /** Parse a single project in streaming mode, sending data to the sink as it's discovered. */
  parseProjectStreaming(claudeDir: string, slug: string, sink: ProjectParseSink, options?: ProjectParserOptions): void;
  parseProject(claudeDir: string, slug: string, options?: ProjectParserOptions): Project | null;
  parseSession(claudeDir: string, slug: string, sessionId: string): Session | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export class ProjectParserImpl implements ProjectParser {
  constructor(private fileService: FileService) {}

  parseAllProjects(claudeDir: string, options?: ProjectParserOptions): Project[] {
    const projectsDir = path.join(claudeDir, 'projects');
    const projects: Project[] = [];
    const planIndex = this.buildPlanIndex(claudeDir);

    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true,
      });

      for (const projectPath of projectPaths) {
        try {
          const slug = path.basename(projectPath);
          const project = this.parseProjectInternal(claudeDir, slug, options, planIndex);
          if (project) projects.push(project);
        } catch {
          // skip bad project
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    return projects;
  }

  parseAllProjectsStreaming(claudeDir: string, sink: ProjectParseSink, options?: ProjectParserOptions): void {
    const projectsDir = path.join(claudeDir, 'projects');
    const planIndex = this.buildPlanIndex(claudeDir);

    // Emit all plans first
    for (const [planSlug, plan] of planIndex) {
      sink.onPlan(planSlug, plan);
    }

    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true,
      });

      for (const projectPath of projectPaths) {
        try {
          const slug = path.basename(projectPath);
          this.parseProjectStreamingInternal(claudeDir, slug, sink, options, planIndex);
        } catch {
          // skip bad project
        }
      }
    } catch {
      // projects dir doesn't exist
    }
  }

  parseProjectStreaming(
    claudeDir: string,
    slug: string,
    sink: ProjectParseSink,
    options?: ProjectParserOptions,
  ): void {
    const planIndex = this.buildPlanIndex(claudeDir);

    // Emit all plans first (same as parseAllProjectsStreaming)
    for (const [planSlug, plan] of planIndex) {
      sink.onPlan(planSlug, plan);
    }

    this.parseProjectStreamingInternal(claudeDir, slug, sink, options, planIndex);
  }

  private parseProjectStreamingInternal(
    claudeDir: string,
    slug: string,
    sink: ProjectParseSink,
    options: ProjectParserOptions | undefined,
    planIndex: Map<string, PlanFile>,
  ): void {
    const projectDir = path.join(claudeDir, 'projects', slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const originalPath = sessionsIndex.originalPath ?? this.slugToPath(slug);
    const skipMessages = options?.skipSessionMessages ?? false;

    sink.onProject(slug, originalPath, sessionsIndex);

    // Emit project memory if present
    const memory = this.parseProjectMemory(slug, projectDir);
    if (memory) {
      sink.onProjectMemory(slug, memory.content);
    }

    // Process each session
    for (const entry of sessionsIndex.entries) {
      try {
        const sessionId = entry.sessionId;
        sink.onSession(slug, entry);

        if (!skipMessages) {
          // Stream messages using the streaming JSONL reader
          const filePath = path.join(projectDir, `${sessionId}.jsonl`);
          let messageCount = 0;
          let lastBytePosition = 0;

          try {
            const streamResult = this.fileService.readJsonlStreaming<SessionMessage>(
              filePath,
              (message, index, byteOffset) => {
                sink.onMessage(slug, sessionId, message, index, byteOffset);
                messageCount++;
                lastBytePosition = byteOffset;
              },
            );
            lastBytePosition = streamResult.finalBytePosition;
          } catch {
            // JSONL file doesn't exist or is unreadable
          }

          // Subagents
          const subagents = this.parseSubagents(projectDir, sessionId);
          for (const subagent of subagents) {
            sink.onSubagent(slug, sessionId, subagent);
          }

          // Tool results
          const toolResults = this.parseToolResults(projectDir, sessionId);
          for (const toolResult of toolResults) {
            sink.onToolResult(slug, sessionId, toolResult);
          }

          sink.onSessionComplete(slug, sessionId, messageCount, lastBytePosition);
        } else {
          sink.onSessionComplete(slug, sessionId, 0, 0);
        }

        // File history (always parsed, not gated by skipMessages)
        const fileHistory = this.parseFileHistory(claudeDir, sessionId);
        if (fileHistory) {
          sink.onFileHistory(sessionId, fileHistory);
        }

        // Todos
        const todos = this.parseTodos(claudeDir, sessionId);
        for (const todo of todos) {
          sink.onTodo(sessionId, todo);
        }

        // Task
        const task = this.parseTask(claudeDir, sessionId);
        if (task) {
          sink.onTask(sessionId, task);
        }
      } catch {
        // skip bad session
      }
    }

    sink.onProjectComplete(slug);
  }

  parseProject(claudeDir: string, slug: string, options?: ProjectParserOptions): Project | null {
    const planIndex = this.buildPlanIndex(claudeDir);
    return this.parseProjectInternal(claudeDir, slug, options, planIndex);
  }

  private parseProjectInternal(
    claudeDir: string,
    slug: string,
    options: ProjectParserOptions | undefined,
    planIndex: Map<string, PlanFile>,
  ): Project | null {
    const projectDir = path.join(claudeDir, 'projects', slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const originalPath = sessionsIndex.originalPath ?? this.slugToPath(slug);

    const sessions: Session[] = [];
    for (const entry of sessionsIndex.entries) {
      try {
        const session = this.buildSession(claudeDir, projectDir, slug, entry, options, planIndex);
        sessions.push(session);
      } catch {
        // skip bad session
      }
    }

    const memory = this.parseProjectMemory(slug, projectDir);

    return { slug, originalPath, sessionsIndex, sessions, memory };
  }

  parseSession(claudeDir: string, slug: string, sessionId: string): Session | null {
    const projectDir = path.join(claudeDir, 'projects', slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const entry = sessionsIndex.entries.find((e) => e.sessionId === sessionId);
    if (!entry) return null;

    const planIndex = this.buildPlanIndex(claudeDir);
    try {
      return this.buildSession(claudeDir, projectDir, slug, entry, undefined, planIndex);
    } catch {
      return null;
    }
  }

  private buildSession(
    claudeDir: string,
    projectDir: string,
    slug: string,
    entry: SessionIndexEntry,
    options: ProjectParserOptions | undefined,
    planIndex: Map<string, PlanFile>,
  ): Session {
    const sessionId = entry.sessionId;
    const skipMessages = options?.skipSessionMessages ?? false;

    const messages = skipMessages ? [] : this.parseSessionMessages(projectDir, sessionId);

    const planSlug = messages.length > 0
      ? this.extractPlanSlugFromMessages(messages, planIndex)
      : this.peekPlanSlug(projectDir, sessionId, planIndex);

    return {
      sessionId,
      indexEntry: entry,
      messages,
      subagents: skipMessages ? [] : this.parseSubagents(projectDir, sessionId),
      toolResults: skipMessages ? [] : this.parseToolResults(projectDir, sessionId),
      fileHistory: this.parseFileHistory(claudeDir, sessionId),
      todos: this.parseTodos(claudeDir, sessionId),
      task: this.parseTask(claudeDir, sessionId),
      plan: planSlug ? planIndex.get(planSlug) ?? null : null,
    };
  }

  private parseSessionsIndex(projectDir: string): SessionsIndex {
    try {
      const index = this.fileService.readJsonSync<SessionsIndex>(
        path.join(projectDir, 'sessions-index.json'),
      );
      if (index && index.entries.length > 0) return index;
      if (index?.originalPath) {
        return { ...index, entries: this.discoverSessionEntries(projectDir, index.originalPath) };
      }
    } catch {
      // sessions-index.json missing or unreadable
    }
    return {
      version: 1,
      entries: this.discoverSessionEntries(projectDir, undefined),
    };
  }

  private discoverSessionEntries(projectDir: string, originalPath: string | undefined): SessionIndexEntry[] {
    const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
    const entries: SessionIndexEntry[] = [];

    let filePaths: string[];
    try {
      filePaths = this.fileService.scanDirectorySync(projectDir, { pattern: '*.jsonl' });
    } catch {
      return entries;
    }

    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      if (!UUID_JSONL.test(fileName)) continue;

      const sessionId = fileName.replace('.jsonl', '');
      const stats = this.fileService.getStats(filePath);
      if (!stats) continue;

      let firstPrompt = '';
      try {
        const result = this.fileService.readJsonlSync<Record<string, unknown>>(filePath);
        for (const msg of result.entries) {
          const message = msg.message as Record<string, unknown> | undefined;
          if (message?.role === 'user') {
            const content = message.content;
            if (typeof content === 'string') {
              firstPrompt = content.slice(0, 200);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as Record<string, unknown>;
                if (b.type === 'text' && typeof b.text === 'string') {
                  firstPrompt = (b.text as string).slice(0, 200);
                  break;
                }
              }
            }
            break;
          }
        }
      } catch {
        // can't read
      }

      const modifiedIso = new Date(stats.mtimeMs).toISOString();
      entries.push({
        sessionId,
        fullPath: filePath,
        fileMtime: stats.mtimeMs,
        firstPrompt: firstPrompt || 'No prompt',
        summary: '',
        messageCount: 0,
        created: modifiedIso,
        modified: modifiedIso,
        gitBranch: '',
        projectPath: originalPath ?? this.slugToPath(path.basename(projectDir)),
        isSidechain: false,
      });
    }

    return entries;
  }

  private parseSessionMessages(projectDir: string, sessionId: string): SessionMessage[] {
    try {
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      const result = this.fileService.readJsonlSync<SessionMessage>(filePath);
      return result.entries;
    } catch {
      return [];
    }
  }

  private parseSubagents(projectDir: string, sessionId: string): SubagentTranscript[] {
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    const transcripts: SubagentTranscript[] = [];

    try {
      const filePaths = this.fileService.scanDirectorySync(subagentsDir, { pattern: '*.jsonl' });

      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const agentId = this.extractAgentId(fileName);
          const agentType = this.inferAgentType(fileName);
          const result = this.fileService.readJsonlSync<SessionMessage>(filePath);

          transcripts.push({ agentId, agentType, fileName, messages: result.entries });
        } catch {
          // skip bad subagent file
        }
      }
    } catch {
      // subagents dir doesn't exist
    }

    return transcripts;
  }

  private extractAgentId(fileName: string): string {
    const match = fileName.match(/^agent-(a.+)\.jsonl$/);
    return match ? match[1] : fileName.replace(/\.jsonl$/, '');
  }

  private inferAgentType(fileName: string): SubagentType {
    if (fileName.includes('prompt_suggestion')) return 'prompt_suggestion';
    if (fileName.includes('compact')) return 'compact';
    return 'task';
  }

  private parseToolResults(projectDir: string, sessionId: string): PersistedToolResult[] {
    const resultsDir = path.join(projectDir, sessionId, 'tool-results');
    const results: PersistedToolResult[] = [];

    try {
      const filePaths = this.fileService.scanDirectorySync(resultsDir, { pattern: '*.txt' });

      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const toolUseId = fileName.replace(/\.txt$/, '');
          const content = this.fileService.readFileSync(filePath);
          results.push({ toolUseId, content });
        } catch {
          // skip bad tool result
        }
      }
    } catch {
      // tool-results dir doesn't exist
    }

    return results;
  }

  private parseProjectMemory(projectSlug: string, projectDir: string): ProjectMemory | null {
    try {
      const content = this.fileService.readFileSync(
        path.join(projectDir, 'memory', 'MEMORY.md'),
      );
      return { projectSlug, content };
    } catch {
      return null;
    }
  }

  private parseFileHistory(claudeDir: string, sessionId: string): FileHistorySession | null {
    const historyDir = path.join(claudeDir, 'file-history', sessionId);

    try {
      const filePaths = this.fileService.scanDirectorySync(historyDir);
      if (filePaths.length === 0) return null;

      const snapshots: FileHistorySnapshotFile[] = [];
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const match = fileName.match(/^([0-9a-f]+)@v(\d+)$/);
          if (!match) continue;

          const content = this.fileService.readFileSync(filePath);
          const stats = this.fileService.getStats(filePath);

          snapshots.push({
            hash: match[1],
            version: parseInt(match[2], 10),
            fileName,
            content,
            size: stats?.size ?? 0,
          });
        } catch {
          // skip bad snapshot file
        }
      }

      return snapshots.length > 0 ? { sessionId, snapshots } : null;
    } catch {
      return null;
    }
  }

  private parseTodos(claudeDir: string, sessionId: string): TodoFile[] {
    const todosDir = path.join(claudeDir, 'todos');
    const todoFiles: TodoFile[] = [];

    try {
      const filePaths = this.fileService.scanDirectorySync(todosDir, {
        pattern: `${sessionId}-agent-*.json`,
      });

      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const match = fileName.match(/^(.+?)-agent-(.+)\.json$/);
          if (!match) continue;

          const items = this.fileService.readJsonSync<TodoItem[]>(filePath) ?? [];

          todoFiles.push({
            sessionId: match[1],
            agentId: match[2],
            items: Array.isArray(items) ? items : [],
          });
        } catch {
          // skip bad todo file
        }
      }
    } catch {
      // todos dir doesn't exist
    }

    return todoFiles;
  }

  private parseTask(claudeDir: string, sessionId: string): TaskEntry | null {
    const taskDir = path.join(claudeDir, 'tasks', sessionId);

    try {
      const lockExists = this.fileService.exists(path.join(taskDir, '.lock'));
      if (!lockExists) return null;

      let hasHighwatermark = false;
      let highwatermark: number | null = null;

      try {
        const hwContent = this.fileService.readFileSync(path.join(taskDir, '.highwatermark'));
        hasHighwatermark = true;
        highwatermark = parseInt(hwContent.trim(), 10);
        if (isNaN(highwatermark)) highwatermark = null;
      } catch {
        // no highwatermark file
      }

      return { taskId: sessionId, hasHighwatermark, highwatermark, lockExists: true };
    } catch {
      return null;
    }
  }

  private buildPlanIndex(claudeDir: string): Map<string, PlanFile> {
    const index = new Map<string, PlanFile>();
    const plansDir = path.join(claudeDir, 'plans');

    try {
      const filePaths = this.fileService.scanDirectorySync(plansDir, { pattern: '*.md' });

      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const planSlug = fileName.replace(/\.md$/, '');
          const content = this.fileService.readFileSync(filePath);
          const stats = this.fileService.getStats(filePath);

          const titleMatch = content.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1] : planSlug;

          index.set(planSlug, { slug: planSlug, title, content, size: stats?.size ?? 0 });
        } catch {
          // skip bad plan file
        }
      }
    } catch {
      // plans dir doesn't exist
    }

    return index;
  }

  private extractPlanSlugFromMessages(
    messages: SessionMessage[],
    planIndex: Map<string, PlanFile>,
  ): string | null {
    for (const msg of messages) {
      const raw = msg as unknown as Record<string, unknown>;
      const slug = raw.slug;
      if (typeof slug === 'string' && planIndex.has(slug)) {
        return slug;
      }
    }
    return null;
  }

  private peekPlanSlug(
    projectDir: string,
    sessionId: string,
    planIndex: Map<string, PlanFile>,
  ): string | null {
    if (planIndex.size === 0) return null;

    try {
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      const content = this.fileService.readFileSync(filePath);

      const slugPattern = /"slug"\s*:\s*"([^"]+)"/;
      const match = content.match(slugPattern);
      if (match) {
        const candidate = match[1];
        if (planIndex.has(candidate)) return candidate;
      }
    } catch {
      // file doesn't exist
    }

    return null;
  }

  private slugToPath(slug: string): string {
    const naive = slug.replace(/^-/, '/').replace(/-/g, '/');
    const parts = slug.replace(/^-/, '').split('-');
    if (parts.length === 0) return naive;

    let resolved = '';
    let i = 0;
    while (i < parts.length) {
      let matched = false;
      for (let end = parts.length; end > i; end--) {
        const candidate = '/' + parts.slice(i, end).join('-');
        const fullCandidate = resolved + candidate;
        const stats = this.fileService.getStats(fullCandidate);
        if (stats) {
          resolved = fullCandidate;
          i = end;
          matched = true;
          break;
        }
      }
      if (!matched) {
        resolved += '/' + parts[i];
        i++;
      }
    }

    return resolved || naive;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createProjectParser(fileService: FileService): ProjectParser {
  return new ProjectParserImpl(fileService);
}
