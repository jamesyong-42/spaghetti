/**
 * CodexLifecycleOwner — Codex's ingest-lifecycle owner (RFC 006 multi-source).
 *
 * Implements the `LifecycleOwner` contract for the Codex source: it ingests
 * Codex rollout files (`sessions/YYYY/MM/DD/rollout-*.jsonl`) into the SHARED
 * store under `sourceId: 'codex'`.
 *
 * Engine:
 * - **rs** (when native addon loads): `native.ingest({ sourceId: 'codex' })`
 * - **ts**: `CodexReader` + this owner's `IngestService`
 *
 * Live (Plane 2, opt-in) still uses the TS writer for Change events + token
 * attribution on incremental tails.
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
import { loadNativeAddon } from '../native.js';
import { resolveEngine, type IngestEngine } from '../settings.js';

/**
 * Bump when Codex message/token extraction changes in a way that requires
 * re-reading rollouts even if mtime is unchanged. Absent or mismatched →
 * force a full Codex re-read once, then stamp the new version.
 */
const CODEX_EXTRACT_VERSION = 'token_count_v2_estimate';
const CODEX_EXTRACT_META_KEY = 'codex_extract_version';

export class CodexLifecycleOwner extends EventEmitter implements LifecycleOwner {
  readonly sourceId = 'codex';
  private ready = false;
  private liveWatch: CodexLiveWatch | undefined;
  private readonly engine: IngestEngine;

  constructor(
    private readonly fileService: FileService,
    private readonly source: AgentSource,
    private readonly store: AgentDataStore,
    private readonly ingestService: IngestService,
    private readonly dbPath: string,
    private readonly errorSink: ErrorSink,
    private readonly live: boolean = false,
    engine?: IngestEngine,
  ) {
    super();
    this.engine = engine ?? resolveEngine();
  }

  async initialize(): Promise<void> {
    this.ready = false;
    const start = Date.now();
    try {
      // Shared SQLite handle — open() is idempotent when already open.
      this.ingestService.open(this.dbPath);
      this.emit('progress', { phase: 'parsing', message: 'Ingesting Codex sessions…' });

      const native = this.engine === 'rs' ? loadNativeAddon() : null;
      if (native) {
        await this.initializeWithNative(native);
      } else {
        await this.initializeWithTypeScript();
      }

      // Plane 2: live watcher after baseline (TS write path for Change events).
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

  /** Native Codex cold/warm path (Rust CodexReader + Writer source_id=codex). */
  private async initializeWithNative(native: NonNullable<ReturnType<typeof loadNativeAddon>>): Promise<void> {
    this.emit('progress', {
      phase: 'parsing',
      message: `Running native Codex ingest (${native.nativeVersion()})…`,
    });
    await native.ingest(
      {
        // rootDir is ~/.codex; NAPI field is still named claudeDir for compat.
        claudeDir: this.source.rootDir,
        dbPath: this.dbPath,
        mode: 'warm',
        sourceId: 'codex',
      },
      (progress) => {
        this.emit('progress', {
          phase: progress.phase === 'finalizing' ? 'storing' : 'parsing',
          message:
            progress.phase === 'scanning'
              ? 'Scanning Codex sessions…'
              : progress.phase === 'finalizing'
                ? 'Finalizing Codex index…'
                : `Ingesting Codex… ${progress.projectsDone}/${progress.projectsTotal}`,
          current: progress.projectsDone,
          total: progress.projectsTotal,
        });
      },
    );
    this.ingestService.setMeta(CODEX_EXTRACT_META_KEY, CODEX_EXTRACT_VERSION);
  }

  /** TypeScript CodexReader path (fallback when native is unavailable). */
  private async initializeWithTypeScript(): Promise<void> {
    const extractVer = this.ingestService.getMeta(CODEX_EXTRACT_META_KEY);
    const forceReread = extractVer !== CODEX_EXTRACT_VERSION;

    const reader = new CodexReader(this.fileService, this.source.paths.sessionsDir);
    this.ingestService.beginTransaction();
    try {
      reader.readAll(this.ingestService, {
        shouldReadMessages: (file, mtimeMs) => {
          if (forceReread) return true;
          const fp = this.ingestService.getFingerprint(file);
          return !fp || fp.mtimeMs !== mtimeMs;
        },
        onFileSeen: (file, mtimeMs, size, lastByte) => {
          this.ingestService.upsertFingerprint({ path: file, mtimeMs, size, bytePosition: lastByte });
        },
      });
      if (forceReread) {
        this.ingestService.setMeta(CODEX_EXTRACT_META_KEY, CODEX_EXTRACT_VERSION);
      }
      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    }
  }

  shutdown(): void {
    this.ready = false;
    void this.liveWatch?.stop();
    this.liveWatch = undefined;
  }

  async shutdownAsync(): Promise<void> {
    this.ready = false;
    if (this.liveWatch) {
      await this.liveWatch.stop();
      this.liveWatch = undefined;
    }
  }

  async rebuild(): Promise<void> {
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
    return this.liveWatch;
  }
}
