/**
 * CodexLifecycleOwner — Codex's ingest-lifecycle owner (RFC 006 multi-source).
 *
 * Implements the `LifecycleOwner` contract for the Codex source: it ingests
 * Codex rollout files (`sessions/YYYY/MM/DD/rollout-*.jsonl`) into the SHARED
 * store under `sourceId: 'codex'`, via its own `IngestService` (bound to that
 * sourceId + the source's `MessageExtractor`) and a `CodexReader`.
 *
 * Engine: TS path only today. There is no native (Rust) Codex reader (RFC §6
 * option A), so a `rs`-pinned service still ingests Codex on the TS path — the
 * native addon only accelerates Claude's bulk path.
 *
 * Cold vs warm: warm-start skips re-reading a rollout whose fingerprint
 * (path + mtime) is unchanged; new/changed files are re-read. Project/session
 * metadata is always refreshed (cheap upserts).
 *
 * Live (Plane 2, opt-in): when `live` is set, after the initial ingest a
 * {@link CodexLiveWatch} watches the rollout tree and streams appended turns
 * into the shared store, so `api.live` reflects Codex activity in real time.
 *
 * Failures are non-fatal: a Codex ingest error emits `error` and leaves the rest
 * of the app (Claude) working — Codex is an additive source, not a dependency.
 */

import { EventEmitter } from 'events';

import type { FileService } from '../io/index.js';
import type { ErrorSink } from '../io/error-sink.js';
import type { AgentSource } from '../sources/types.js';
import { CodexReader } from '../sources/codex/reader.js';
import { createCodexLiveWatch, type CodexLiveWatch } from '../sources/codex/live-watch.js';
import type { AgentDataStore } from './agent-data-store.js';
import type { IngestService } from './ingest-service.js';
import type { LifecycleOwner } from './lifecycle-owner.js';
import type { LiveWatch } from '../live/live-watch.js';

export class CodexLifecycleOwner extends EventEmitter implements LifecycleOwner {
  readonly sourceId = 'codex';
  private ready = false;
  private liveWatch: CodexLiveWatch | undefined;

  constructor(
    private readonly fileService: FileService,
    private readonly source: AgentSource,
    private readonly store: AgentDataStore,
    private readonly ingestService: IngestService,
    private readonly dbPath: string,
    private readonly errorSink: ErrorSink,
    private readonly live: boolean = false,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.ready = false;
    const start = Date.now();
    try {
      // Shared SQLite handle — open() is idempotent when already open.
      this.ingestService.open(this.dbPath);
      this.emit('progress', { phase: 'parsing', message: 'Ingesting Codex sessions…' });

      const reader = new CodexReader(this.fileService, this.source.paths.sessionsDir);
      this.ingestService.beginTransaction();
      try {
        reader.readAll(this.ingestService, {
          // Warm-start: skip a rollout whose fingerprint is unchanged.
          shouldReadMessages: (file, mtimeMs) => {
            const fp = this.ingestService.getFingerprint(file);
            return !fp || fp.mtimeMs !== mtimeMs;
          },
          onFileSeen: (file, mtimeMs, size, lastByte) => {
            this.ingestService.upsertFingerprint({ path: file, mtimeMs, size, bytePosition: lastByte });
          },
        });
        this.ingestService.commitTransaction();
      } catch (error) {
        this.ingestService.rollbackTransaction();
        throw error;
      }

      // Plane 2: start the live watcher once the baseline is caught up.
      if (this.live && !this.liveWatch) {
        this.liveWatch = createCodexLiveWatch({
          fileService: this.fileService,
          sessionsDir: this.source.paths.sessionsDir,
          ingestService: this.ingestService,
          store: this.store,
          errorSink: this.errorSink,
        });
        await this.liveWatch.start();
      }

      this.ready = true;
      this.emit('ready', { durationMs: Date.now() - start });
    } catch (error) {
      // Non-fatal: keep the rest of the app alive if Codex ingest fails.
      this.emit('error', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  shutdown(): void {
    this.ready = false;
    // Best-effort stop; shutdownAsync awaits it properly.
    void this.liveWatch?.stop();
    this.liveWatch = undefined;
    // The shared SQLite handle is closed by the primary (Claude) owner; this
    // owner must not double-close it.
  }

  async shutdownAsync(): Promise<void> {
    this.ready = false;
    if (this.liveWatch) {
      await this.liveWatch.stop();
      this.liveWatch = undefined;
    }
  }

  async rebuild(): Promise<void> {
    // No per-source wipe yet (deleteAllData would clear every source). The
    // coordinator runs the primary owner's rebuild first, which wipes the DB
    // (and Codex's fingerprints); re-initializing here then cold-reads Codex.
    await this.initialize();
  }

  async rebuildIndex(): Promise<{ durationMs: number }> {
    const start = Date.now();
    await this.rebuild();
    return { durationMs: Date.now() - start };
  }

  isReady(): boolean {
    return this.ready;
  }

  getStore(): AgentDataStore {
    return this.store;
  }

  getLiveWatch(): LiveWatch | undefined {
    // Codex's LiveWatch (no `prewarm` scopes — it watches the whole rollout
    // tree); emits into the shared store, which `api.live` observes.
    return this.liveWatch;
  }
}
