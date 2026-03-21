/**
 * Workers Module — Worker thread pool for parallel project parsing
 */

export type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  WorkerParseRequest,
  WorkerShutdownRequest,
  WorkerProjectResult,
  WorkerProjectMemoryResult,
  WorkerSessionResult,
  WorkerMessageBatch,
  WorkerSubagentResult,
  WorkerToolResultResult,
  WorkerFileHistoryResult,
  WorkerTodoResult,
  WorkerTaskResult,
  WorkerPlanResult,
  WorkerSessionComplete,
  WorkerProjectComplete,
  WorkerError,
} from './worker-types.js';

export {
  type WorkerPoolOptions,
  type WorkerPool,
  createWorkerPool,
  isWorkerThreadsAvailable,
} from './worker-pool.js';
