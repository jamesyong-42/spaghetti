/**
 * CodexLifecycleOwner — Codex's ingest-lifecycle owner (RFC 006 multi-source).
 *
 * Lives under `sources/codex/` (product code). Implements the shared
 * `LifecycleOwner` contract: ingests Codex rollouts
 * (`sessions/YYYY/MM/DD/rollout-*.jsonl`) into the SHARED store under
 * `sourceId: 'codex'`.
 *
 * Engine:
 * - **rs** (when native addon loads AND the shared SQLite handle is not yet
 *   open): `native.ingest({ sourceId: 'codex' })` with exclusive access
 * - **ts** otherwise — including when Claude (or another owner) already
 *   opened better-sqlite3 on the same file. Native bulk uses
 *   `journal_mode=MEMORY`, which races with a live better-sqlite3 connection
 *   and can SQLITE_CORRUPT the cache.
 *
 * Live (Plane 2, opt-in) always uses the TS writer for Change events + token
 * attribution on incremental tails.
 *
 * Failures are non-fatal: a Codex ingest error emits `error` and leaves the rest
 * of the app (Claude) working — Codex is an additive source, not a dependency.
 */

import { EventEmitter } from 'events';

import type { FileService } from '../../io/index.js';
import type { ErrorSink } from '../../io/error-sink.js';
import type { AgentSource } from '../types.js';
import type { AgentDataStore } from '../../data/agent-data-store.js';
import type { IngestService } from '../../data/ingest-service.js';
import type { LifecycleOwner } from '../../data/lifecycle-owner.js';
import type { LiveWatch } from '../../live/live-watch.js';
import { loadNativeAddon } from '../../native.js';
import { resolveEngine, type IngestEngine } from '../../settings.js';
import { CodexReader } from './reader.js';
import { createCodexLiveWatch, type CodexLiveWatch } from './live-watch.js';

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
      this.emit('progress', { phase: 'parsing', message: 'Ingesting Codex sessions…' });

      const native = this.engine === 'rs' ? loadNativeAddon() : null;
      // Exclusive native only when no peer already holds better-sqlite3.
      // Shared multi-source: primary (Claude) opens first → we take the TS path.
      const sharedAlreadyOpen = this.ingestService.isOpen();

      if (native && !sharedAlreadyOpen) {
        // Native first (exclusive), then open the shared handle for meta/live.
        await this.initializeWithNative(native);
        this.ingestService.open(this.dbPath);
        this.ingestService.setMeta(CODEX_EXTRACT_META_KEY, CODEX_EXTRACT_VERSION);
      } else {
        this.ingestService.open(this.dbPath);
        if (native && sharedAlreadyOpen) {
          this.emit('progress', {
            phase: 'parsing',
            message: 'Codex: shared DB open — using TypeScript ingest (safe with multi-source)…',
          });
        }
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
        agentDir: this.source.rootDir,
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
  }

  /** TypeScript CodexReader path (fallback when native is unavailable or unsafe). */
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
