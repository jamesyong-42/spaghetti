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
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to lifecycle events from the main process.
  useEffect(() => {
    const bridge = window.spaghetti;

    const unsubProgress = bridge.onProgress((p) => {
      setPhase(`${p.phase}${p.message ? ` — ${p.message}` : ''}`);
    });
    const unsubReady = bridge.onReady((info) => {
      setReady(true);
      setPhase(`Ready in ${info.durationMs}ms`);
    });

    void bridge.isReady().then((r) => {
      if (r) setReady(true);
    });

    return () => {
      unsubProgress();
      unsubReady();
    };
  }, []);

  // Load projects once ready.
  useEffect(() => {
    if (!ready) return;
    window.spaghetti
      .getProjectList()
      .then(setProjects)
      .catch((e: unknown) => setError(String(e)));
  }, [ready]);

  // Load sessions for selected project.
  useEffect(() => {
    if (!selectedSlug) {
      setSessions([]);
      return;
    }
    window.spaghetti
      .getSessionList(selectedSlug)
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  }, [selectedSlug]);

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
