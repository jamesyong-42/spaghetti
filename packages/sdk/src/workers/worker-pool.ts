/**
 * Worker Pool — Manages a pool of parse workers for parallel project parsing
 *
 * Distributes project slugs across workers using a queue-based approach.
 * When a worker completes a project, it receives the next one from the queue.
 * All messages from workers are forwarded to the caller's onMessage callback
 * for SQLite ingestion on the main thread (single-writer constraint).
 */

import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import type { WorkerToMainMessage, MainToWorkerMessage } from './worker-types.js';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkerPoolOptions {
  /** Maximum number of worker threads. Defaults to min(cpus - 1, 4). */
  maxWorkers?: number;
  /** Path to the compiled parse-worker.js script. */
  workerScript?: string;
}

export interface WorkerPool {
  /**
   * Parse multiple projects in parallel using worker threads.
   *
   * @param claudeDir - Path to the .claude directory
   * @param slugs - Project slugs to parse
   * @param onMessage - Callback for each message from any worker (main thread handles SQLite writes)
   * @returns Promise that resolves when ALL projects are complete
   */
  parseProjects(claudeDir: string, slugs: string[], onMessage: (msg: WorkerToMainMessage) => void): Promise<void>;

  /** Shut down all workers. */
  shutdown(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

class WorkerPoolImpl implements WorkerPool {
  private maxWorkers: number;
  private workerScript: string;
  private workers: Worker[] = [];

  constructor(options?: WorkerPoolOptions) {
    // Leave 1 core for main thread SQLite writes, cap at 4
    this.maxWorkers = options?.maxWorkers ?? Math.min(os.cpus().length - 1, 4);
    if (this.maxWorkers < 1) this.maxWorkers = 1;

    // Resolve worker script path relative to this file
    this.workerScript = options?.workerScript ?? new URL('./parse-worker.js', import.meta.url).pathname;
  }

  async parseProjects(
    claudeDir: string,
    slugs: string[],
    onMessage: (msg: WorkerToMainMessage) => void,
  ): Promise<void> {
    if (slugs.length === 0) return;

    const workerCount = Math.min(this.maxWorkers, slugs.length);
    const queue = [...slugs];
    let completedCount = 0;
    const totalCount = slugs.length;
    // Track workers whose crash has already been counted (by the 'error' handler)
    // to avoid double-counting when the 'exit' handler also fires.
    const errorCountedWorkers = new Set<Worker>();

    return new Promise<void>((resolve, reject) => {
      let hasRejected = false;

      const assignNext = (worker: Worker): void => {
        const slug = queue.shift();
        if (slug) {
          worker.postMessage({
            type: 'parse-project',
            claudeDir,
            slug,
          } satisfies MainToWorkerMessage);
        }
      };

      // Spawn workers
      for (let i = 0; i < workerCount; i++) {
        let worker: Worker;
        try {
          worker = new Worker(this.workerScript);
        } catch (err) {
          // If worker creation fails, reject with a clear error
          if (!hasRejected) {
            hasRejected = true;
            reject(
              new Error(`Failed to create worker thread: ${String(err)}. ` + `Worker script: ${this.workerScript}`),
            );
          }
          return;
        }

        this.workers.push(worker);

        worker.on('message', (msg: WorkerToMainMessage) => {
          // Forward the message to the main thread handler
          onMessage(msg);

          // When a project completes, assign the next one or check if all done
          if (msg.type === 'project-complete') {
            completedCount++;
            if (queue.length > 0) {
              assignNext(worker);
            } else if (completedCount >= totalCount) {
              resolve();
            }
          }

          // If a worker reports an error, log but continue (graceful degradation)
          if (msg.type === 'worker-error') {
            completedCount++;
            console.error(`[worker-pool] Error parsing project "${msg.slug}": ${msg.error}`);
            if (queue.length > 0) {
              assignNext(worker);
            } else if (completedCount >= totalCount) {
              resolve();
            }
          }
        });

        worker.on('error', (err) => {
          // Worker process-level error (e.g. uncaught exception)
          console.error(`[worker-pool] Worker error:`, err);
          errorCountedWorkers.add(worker);
          completedCount++;

          // Try to replace the dead worker if there are more slugs to process
          if (queue.length > 0 && !hasRejected) {
            try {
              const replacement = new Worker(this.workerScript);
              const idx = this.workers.indexOf(worker);
              if (idx >= 0) this.workers[idx] = replacement;
              else this.workers.push(replacement);

              // Re-attach listeners (clone the event handling)
              replacement.on('message', worker.listeners('message')[0] as (msg: WorkerToMainMessage) => void);
              replacement.on('error', worker.listeners('error')[0] as (err: Error) => void);
              replacement.on('exit', worker.listeners('exit')[0] as (code: number) => void);

              assignNext(replacement);
            } catch {
              // Can't replace — just continue
              if (completedCount >= totalCount) {
                resolve();
              }
            }
          } else if (completedCount >= totalCount) {
            resolve();
          }
        });

        worker.on('exit', (code) => {
          if (code !== 0 && completedCount < totalCount && !errorCountedWorkers.has(worker)) {
            // Worker exited abnormally without sending 'project-complete' or
            // 'worker-error', AND the 'error' event didn't fire (or didn't
            // account for this worker). This can happen if the worker crashes
            // hard (e.g., segfault, OOM kill) before it can send a message.
            // Increment completedCount to prevent the Promise from hanging forever.
            completedCount++;
            if (completedCount >= totalCount) {
              resolve();
            }
          }
        });

        // Assign initial work
        assignNext(worker);
      }
    });
  }

  shutdown(): void {
    for (const worker of this.workers) {
      try {
        worker.postMessage({ type: 'shutdown' } satisfies MainToWorkerMessage);
      } catch {
        // Worker may already be terminated
      }
    }
    // Force terminate after a brief delay
    setTimeout(() => {
      for (const worker of this.workers) {
        try {
          worker.terminate();
        } catch {
          // Already terminated
        }
      }
      this.workers = [];
    }, 100);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY & UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if worker_threads is available in the current runtime.
 * Since we import Worker at the top of this module, if we got here
 * without error, worker_threads is available.
 */
export function isWorkerThreadsAvailable(): boolean {
  try {
    // The Worker class is imported at the top of this module from 'node:worker_threads'.
    // If that import succeeded, worker_threads is available.
    return typeof Worker === 'function';
  } catch {
    return false;
  }
}

/**
 * Create a new worker pool for parallel project parsing.
 */
export function createWorkerPool(options?: WorkerPoolOptions): WorkerPool {
  return new WorkerPoolImpl(options);
}
