/**
 * Parse Worker — Worker thread entry point for parallel project parsing
 *
 * Each worker receives a project slug, creates its own FileService and
 * ProjectParser instances, parses the project, and sends structured messages
 * back to the main thread via parentPort.postMessage().
 *
 * Messages are batched (every 150 messages) to reduce IPC overhead.
 * The main thread handles all SQLite writes (single-writer constraint).
 */

import { parentPort } from 'node:worker_threads';
import { createFileService } from '../io/file-service.js';
import { createProjectParser } from '../parser/project-parser.js';
import type { MainToWorkerMessage, WorkerMessageBatch } from './worker-types.js';
import type { ProjectParseSink } from '../parser/parse-sink.js';

if (!parentPort) {
  throw new Error('parse-worker must be run as a worker thread');
}

// Each worker creates its own FileService and ProjectParser (no shared state)
const fileService = createFileService();
const parser = createProjectParser(fileService);

const port = parentPort;

port.on('message', (msg: MainToWorkerMessage) => {
  if (msg.type === 'shutdown') {
    process.exit(0);
  }

  if (msg.type === 'parse-project') {
    const startTime = Date.now();
    const { claudeDir, slug } = msg;

    try {
      // ── Message batching state ──────────────────────────────────────
      let messageBatch: string[] = [];
      let batchStartIndex = 0;
      let batchByteOffsets: number[] = [];
      let currentSlug = '';
      let currentSessionId = '';

      const flushBatch = (): void => {
        if (messageBatch.length > 0) {
          port.postMessage({
            type: 'message-batch',
            slug: currentSlug,
            sessionId: currentSessionId,
            messages: messageBatch,
            startIndex: batchStartIndex,
            byteOffsets: batchByteOffsets,
          } satisfies WorkerMessageBatch);
          messageBatch = [];
          batchByteOffsets = [];
        }
      };

      // ── ProjectParseSink that sends messages to main thread ─────────
      const sink: ProjectParseSink = {
        onProject(slug, originalPath, sessionsIndex) {
          port.postMessage({
            type: 'project-result',
            slug,
            originalPath,
            sessionsIndexJson: JSON.stringify(sessionsIndex),
          });
        },

        onProjectMemory(slug, content) {
          port.postMessage({ type: 'project-memory', slug, content });
        },

        onSession(slug, entry) {
          port.postMessage({
            type: 'session-result',
            slug,
            sessionId: entry.sessionId,
            indexEntryJson: JSON.stringify(entry),
          });
        },

        onMessage(slug, sessionId, message, index, byteOffset) {
          // If we switched sessions, flush the current batch
          if (currentSessionId !== sessionId) {
            flushBatch();
            currentSlug = slug;
            currentSessionId = sessionId;
            batchStartIndex = index;
          }

          messageBatch.push(JSON.stringify(message));
          batchByteOffsets.push(byteOffset);

          // Flush when batch reaches threshold (500 messages — larger batches
          // reduce IPC round-trips between worker and main thread)
          if (messageBatch.length >= 500) {
            flushBatch();
            batchStartIndex = index + 1;
          }
        },

        onSubagent(slug, sessionId, transcript) {
          flushBatch();
          port.postMessage({
            type: 'subagent-result',
            slug,
            sessionId,
            agentId: transcript.agentId,
            agentType: transcript.agentType,
            fileName: transcript.fileName,
            messagesJson: JSON.stringify(transcript.messages),
            messageCount: transcript.messages.length,
          });
        },

        onToolResult(slug, sessionId, toolResult) {
          port.postMessage({
            type: 'tool-result',
            slug,
            sessionId,
            toolUseId: toolResult.toolUseId,
            content: toolResult.content,
          });
        },

        onFileHistory(sessionId, history) {
          port.postMessage({
            type: 'file-history',
            sessionId,
            dataJson: JSON.stringify(history),
          });
        },

        onTodo(sessionId, todo) {
          port.postMessage({
            type: 'todo-result',
            sessionId,
            agentId: todo.agentId,
            itemsJson: JSON.stringify(todo.items),
          });
        },

        onTask(sessionId, task) {
          port.postMessage({
            type: 'task-result',
            sessionId,
            taskJson: JSON.stringify(task),
          });
        },

        onPlan(slug, plan) {
          port.postMessage({
            type: 'plan-result',
            slug,
            title: plan.title,
            content: plan.content,
            size: plan.size,
          });
        },

        onSessionComplete(slug, sessionId, messageCount, lastBytePosition) {
          flushBatch();
          port.postMessage({
            type: 'session-complete',
            slug,
            sessionId,
            messageCount,
            lastBytePosition,
          });
        },

        onProjectComplete(slug) {
          flushBatch();
          port.postMessage({
            type: 'project-complete',
            slug,
            durationMs: Date.now() - startTime,
          });
        },
      };

      // Parse just this one project using the single-project streaming method
      parser.parseProjectStreaming(claudeDir, slug, sink);
    } catch (err) {
      port.postMessage({
        type: 'worker-error',
        slug,
        error: String(err),
      });
    }
  }
});
