import { useEffect, useState } from 'react';
import { SpaghettiProvider, type SpaghettiProviderProps } from '@vibecook/spaghetti-sdk/react';
import type { ProjectListItem, SessionListItem } from '@vibecook/spaghetti-sdk';
import { createIpcApi } from './ipc-api.js';

/**
 * Minimal playground shell — lists projects and their sessions.
 *
 * We don't mount <AgentDataPlayground /> directly because that component
 * assumes the SpaghettiAPI returns synchronous data. Over IPC every call
 * resolves asynchronously, so we render a bespoke read-only UI that awaits
 * the promises and shows the core shape of the data.
 */
export function App() {
  const [api] = useState(() => createIpcApi());

  return (
    <SpaghettiProvider api={api as SpaghettiProviderProps['api']}>
      <PlaygroundShell />
    </SpaghettiProvider>
  );
}

function PlaygroundShell() {
  const [phase, setPhase] = useState<string>('Waiting for SDK...');
  const [ready, setReady] = useState(false);
  const [engine, setEngine] = useState<'rs' | 'ts' | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `onChange` events to re-trigger the project/session fetches
  // without inventing a bespoke store layer. A simple nonce is enough: the
  // fetches are idempotent and cheap.
  const [changeNonce, setChangeNonce] = useState(0);

  // Subscribe to lifecycle + change events from the main process.
  useEffect(() => {
    const bridge = window.spaghetti;

    const unsubProgress = bridge.onProgress((p) => {
      setPhase(`${p.phase}${p.message ? ` — ${p.message}` : ''}`);
    });
    const unsubReady = bridge.onReady((info) => {
      setReady(true);
      setPhase(`Ready in ${info.durationMs}ms`);
    });
    const unsubChange = bridge.onChange(() => {
      // Trigger a refetch of the projects list (and sessions for the
      // currently-selected project) the next render cycle.
      setChangeNonce((n) => n + 1);
    });

    void bridge.isReady().then((r) => {
      if (r) setReady(true);
    });
    void bridge.getEngine().then(setEngine);

    return () => {
      unsubProgress();
      unsubReady();
      unsubChange();
    };
  }, []);

  // Load projects once ready — and whenever the main process emits a change.
  useEffect(() => {
    if (!ready) return;
    window.spaghetti
      .getProjectList()
      .then(setProjects)
      .catch((e: unknown) => setError(String(e)));
  }, [ready, changeNonce]);

  // Load sessions for selected project (also refetch on change).
  useEffect(() => {
    if (!selectedSlug) {
      setSessions([]);
      return;
    }
    window.spaghetti
      .getSessionList(selectedSlug)
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  }, [selectedSlug, changeNonce]);

  const onRebuild = async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setError(null);
    setPhase('Rebuilding index...');
    try {
      const { durationMs } = await window.spaghetti.rebuildIndex();
      setPhase(`Rebuilt in ${durationMs}ms`);
      setChangeNonce((n) => n + 1);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.02)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <strong style={{ fontSize: 13 }}>Spaghetti Playground</strong>
        {engine && (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: engine === 'rs' ? 'rgba(200,100,255,0.15)' : 'rgba(150,200,255,0.15)',
              color: engine === 'rs' ? '#d4a5ff' : '#a5cbff',
              fontFamily: 'monospace',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
            title={engine === 'rs' ? 'Native Rust ingest engine' : 'TypeScript ingest engine'}
          >
            engine: {engine}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 4,
            background: ready ? 'rgba(0,200,100,0.2)' : 'rgba(255,200,0,0.2)',
            color: ready ? '#6fe5a1' : '#ffd966',
          }}
        >
          {phase}
        </span>
        <button
          type="button"
          onClick={() => void onRebuild()}
          disabled={!ready || rebuilding}
          style={{
            fontSize: 11,
            padding: '3px 10px',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.04)',
            color: 'inherit',
            cursor: ready && !rebuilding ? 'pointer' : 'default',
            opacity: ready && !rebuilding ? 1 : 0.5,
          }}
          title="Force a full cold rebuild of the SQLite index from ~/.claude"
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
        </button>
        {error && (
          <span style={{ fontSize: 11, color: '#ff6b6b' }} title={error}>
            error: {error.slice(0, 80)}
          </span>
        )}
      </header>

      <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <section
          style={{
            width: 320,
            borderRight: '1px solid rgba(255,255,255,0.1)',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              padding: '6px 12px',
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            Projects ({projects.length})
          </div>
          {projects.map((p) => (
            <button
              key={p.slug}
              type="button"
              onClick={() => setSelectedSlug(p.slug)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 12px',
                background: selectedSlug === p.slug ? 'rgba(100,150,255,0.15)' : 'transparent',
                color: 'inherit',
                border: 'none',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 500 }}>{p.folderName}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                {p.sessionCount} sessions · {p.messageCount} msgs
              </div>
            </button>
          ))}
        </section>

        <section style={{ flex: 1, overflowY: 'auto' }}>
          <div
            style={{
              padding: '6px 12px',
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            {selectedSlug ? `Sessions (${sessions.length})` : 'Select a project'}
          </div>
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
                fontSize: 12,
              }}
            >
              <div style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.6 }}>{s.sessionId.slice(0, 8)}</div>
              <div>{s.summary || s.firstPrompt || '(no summary)'}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                {s.messageCount} msgs · {s.gitBranch || 'no branch'}
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
