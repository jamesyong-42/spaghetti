/**
 * GrokLifecycleOwner — Grok's ingest-lifecycle owner (RFC 006 multi-source).
 *
 * Lives under `sources/grok/` (product code). Implements the shared
 * `LifecycleOwner` contract: ingests Grok sessions into the SHARED store under
 * `sourceId: 'grok'`.
 *
 * Unlike Codex, Grok has **no native (Rust) ingest path** — the native addon is
 * Claude/Codex-shaped and knows nothing of Grok's directory-per-session layout —
 * so this owner is pure-TypeScript: {@link GrokReader} drives `IngestService`
 * directly in every phase.
 *
 * Multi-source three-phase protocol (so peers can still take native rs):
 *   1. `exclusiveIngest` — open → GrokReader.readAll → close (shared handle must
 *      not stay open while a peer wants exclusive native access).
 *   2. `attachShared`    — reopen the shared handle + stamp extract meta.
 *   3. `startLivePipeline`— DEFERRED: Grok live tailing is a follow-up (A6). Cold
 *      + warm ingest already surface every session; new turns appear on the next
 *      rebuild/restart until the live watch lands.
 *
 * Failures are non-fatal (emit `error`, leave the primary source up).
 */

import { EventEmitter } from 'events';

import type { FileService } from '../../io/index.js';
import type { ErrorSink } from '../../io/error-sink.js';
import type { AgentSource } from '../types.js';
import type { AgentDataStore } from '../../data/agent-data-store.js';
import type { IngestService } from '../../data/ingest-service.js';
import type { LifecycleOwner } from '../../data/lifecycle-owner.js';
import type { LiveWatch } from '../../live/live-watch.js';
import { GrokReader } from './reader.js';

/**
 * Bump when Grok message extraction changes in a way that requires re-reading
 * chat_history files even if mtime is unchanged. Absent/mismatched → force a
 * full Grok re-read once, then stamp the new version.
 */
const GROK_EXTRACT_VERSION = 'grok_v1';
const GROK_EXTRACT_META_KEY = 'grok_extract_version';

export class GrokLifecycleOwner extends EventEmitter implements LifecycleOwner {
  readonly sourceId = 'grok';
  private ready = false;

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

  /** Solo composition of the three multi-source phases. */
  async initialize(): Promise<void> {
    this.ready = false;
    const start = Date.now();
    try {
      await this.exclusiveIngest();
      await this.attachShared();
      await this.startLivePipeline();
      this.ready = true;
      this.emit('ready', { durationMs: Date.now() - start });
    } catch (error) {
      this.emit('error', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Phase 1 — exclusive cold/warm (pure TS). Open → read → close. */
  async exclusiveIngest(): Promise<void> {
    this.ready = false;
    this.emit('progress', { phase: 'parsing', message: 'Ingesting Grok sessions…' });
    this.releaseShared();
    this.ingestService.open(this.dbPath);
    try {
      this.readWithTypeScript();
    } finally {
      this.releaseShared();
    }
  }

  /** Phase 2 — reopen shared handle + stamp extract version meta. */
  async attachShared(): Promise<void> {
    this.ingestService.open(this.dbPath);
    this.ingestService.setMeta(GROK_EXTRACT_META_KEY, GROK_EXTRACT_VERSION);
  }

  /** Phase 3 — DEFERRED (A6). Live tailing of chat_history.jsonl is a follow-up. */
  async startLivePipeline(): Promise<void> {
    if (this.live) {
      this.emit('progress', { phase: 'parsing', message: 'Grok live tail not yet implemented — cold index only.' });
    }
    this.ready = true;
  }

  releaseShared(): void {
    try {
      this.ingestService.close();
    } catch {
      /* ignore — may already be closed by a peer that shares the handle */
    }
  }

  /** Pure-TS GrokReader path. Handle must be open. */
  private readWithTypeScript(): void {
    const extractVer = this.ingestService.getMeta(GROK_EXTRACT_META_KEY);
    const forceReread = extractVer !== GROK_EXTRACT_VERSION;

    const reader = new GrokReader(this.fileService, this.source.paths.sessionsDir);
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
        this.ingestService.setMeta(GROK_EXTRACT_META_KEY, GROK_EXTRACT_VERSION);
      }
      this.ingestService.commitTransaction();
    } catch (error) {
      this.ingestService.rollbackTransaction();
      throw error;
    }
  }

  shutdown(): void {
    this.ready = false;
  }

  async shutdownAsync(): Promise<void> {
    this.ready = false;
  }

  async rebuild(): Promise<void> {
    await this.initialize();
  }

  async rebuildIndex(): Promise<{ durationMs: number }> {
    const start = Date.now();
    await this.initialize();
    return { durationMs: Date.now() - start };
  }

  isReady(): boolean {
    return this.ready;
  }

  getStore(): AgentDataStore {
    return this.store;
  }

  getLiveWatch(): LiveWatch | undefined {
    return undefined;
  }
}
