/**
 * DoctorView — TUI health check screen
 *
 * Mirrors `spag doctor` CLI output but rendered with Ink components.
 * Pulls state via `collectDoctorReport()` so it stays structurally in sync
 * with the CLI view.
 *
 * Keys:
 *   r   refresh
 *   Esc pop back to previous view
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useViewNav } from './context.js';
import { VERSION } from './shell.js';
import {
  collectDoctorReport,
  formatRelative,
  pluginStatusKind,
  PLUGIN_STATUS_LABEL,
  tildify,
  type DoctorReport,
  type PluginReport,
  type PluginStatusKind,
} from '../lib/doctor-report.js';

// ─── Status icons ──────────────────────────────────────────────────────

function StatusIcon({ kind }: { kind: PluginStatusKind | 'ok' | 'warn' | 'bad' | 'dot' }): React.ReactElement {
  if (kind === 'ok') return <Text color="green">✓</Text>;
  if (kind === 'warn') return <Text color="yellow">!</Text>;
  if (kind === 'bad') return <Text color="red">✗</Text>;
  if (kind === 'dot') return <Text dimColor>·</Text>;
  // PluginStatusKind
  if (kind === 'not-installed') return <Text color="red">✗</Text>;
  if (kind === 'path-missing' || kind === 'disabled') return <Text color="yellow">!</Text>;
  return <Text color="green">✓</Text>;
}

const LABEL_WIDTH = 18;

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactElement;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text>{'  '}</Text>
      {icon}
      <Text> </Text>
      <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
      <Text>{'  '}</Text>
      <Box>
        <Text>{children}</Text>
      </Box>
    </Box>
  );
}

function Sub({ children }: { children: React.ReactNode }): React.ReactElement {
  // Indent: 2 (base) + 2 (icon+space) + LABEL_WIDTH + 2 (separator)
  return (
    <Box>
      <Text>{' '.repeat(2 + 2 + LABEL_WIDTH + 2)}</Text>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

function SectionHeading({ title }: { title: string }): React.ReactElement {
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text bold>{title}</Text>
    </Box>
  );
}

function Spacer(): React.ReactElement {
  return <Text> </Text>;
}

// ─── Plugin row rendering ──────────────────────────────────────────────

function PluginRow({ plugin }: { plugin: PluginReport }): React.ReactElement {
  const kind = pluginStatusKind(plugin.state);
  const label = PLUGIN_STATUS_LABEL[kind];
  const statusColor =
    kind === 'ok' ? 'green' : kind === 'not-installed' ? 'red' : 'yellow';

  const version = plugin.state.version ? `  v${plugin.state.version}` : '';

  return (
    <>
      <Row icon={<StatusIcon kind={kind} />} label={plugin.name}>
        <Text color={statusColor}>{label}</Text>
        <Text dimColor>{version}</Text>
      </Row>
      <Sub>{plugin.description}</Sub>
      {kind === 'not-installed' && (
        <Sub>
          <Text color="cyan">→ spag plugin install {plugin.name}</Text>
        </Sub>
      )}
      {kind === 'disabled' && <Sub>→ enable in ~/.claude/settings.json (enabledPlugins)</Sub>}
      {kind === 'path-missing' && plugin.state.installPath && (
        <Sub>path: {tildify(plugin.state.installPath)}</Sub>
      )}
    </>
  );
}

// ─── DoctorView ────────────────────────────────────────────────────────

export function DoctorView(): React.ReactElement {
  const nav = useViewNav();
  const [report, setReport] = useState<DoctorReport>(() => collectDoctorReport(VERSION));
  const [lastRefreshed, setLastRefreshed] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setReport(collectDoctorReport(VERSION));
    setLastRefreshed(Date.now());
  }, []);

  useInput(
    (input, key) => {
      if (key.escape) {
        nav.pop();
        return;
      }
      if (input === 'r' || input === 'R') {
        refresh();
      }
    },
    { isActive: !nav.searchMode },
  );

  const env = report.environment;
  const he = report.hookEvents;
  const cs = report.channelSessions;

  return (
    <Box flexDirection="column">
      <Spacer />
      <Box>
        <Text>{'  '}</Text>
        <Text bold>Spaghetti Doctor</Text>
        <Text>{'  '}</Text>
        <Text dimColor>v{report.version}</Text>
        <Text>{'  '}</Text>
        <Text dimColor>· refreshed {formatRelative(lastRefreshed)}</Text>
      </Box>
      <Spacer />

      {/* Environment */}
      <SectionHeading title="Environment" />
      <Row icon={<StatusIcon kind="ok" />} label="Node">
        {env.node} ({env.platform} {env.arch})
      </Row>
      {env.claudeBin ? (
        <Row icon={<StatusIcon kind="ok" />} label="claude CLI">
          {env.claudeBin}
        </Row>
      ) : (
        <Row icon={<StatusIcon kind="bad" />} label="claude CLI">
          <Text color="red">not found in PATH</Text>
        </Row>
      )}
      <Row icon={<StatusIcon kind={env.claudeDir.exists ? 'ok' : 'bad'} />} label="~/.claude">
        {tildify(env.claudeDir.path)}
      </Row>
      <Row icon={<StatusIcon kind={env.settings.exists ? 'ok' : 'warn'} />} label="settings.json">
        {tildify(env.settings.path)}
      </Row>
      <Row icon={<StatusIcon kind={env.pluginsDir.exists ? 'ok' : 'warn'} />} label="plugins dir">
        {tildify(env.pluginsDir.path)}
      </Row>
      <Spacer />

      {/* Plugins */}
      <SectionHeading title="Plugins" />
      {report.plugins.map((p) => (
        <PluginRow key={p.name} plugin={p} />
      ))}
      <Spacer />

      {/* Hook events */}
      <SectionHeading title="Hook events" />
      {he.kind === 'ok' ? (
        <>
          <Row icon={<StatusIcon kind="ok" />} label="events file">
            {tildify(he.path)}
          </Row>
          <Sub>
            {he.count.toLocaleString()} event(s), updated {formatRelative(he.mtimeMs)}
          </Sub>
        </>
      ) : he.kind === 'missing' ? (
        <>
          <Row icon={<StatusIcon kind="bad" />} label="events file">
            <Text color="red">none</Text>
          </Row>
          <Sub>expected at {tildify(he.path)}</Sub>
          <Sub>
            <Text color="cyan">→ spag plugin install spaghetti-hooks</Text>
          </Sub>
        </>
      ) : (
        <Row icon={<StatusIcon kind="bad" />} label="events file">
          <Text color="red">read error: {he.message}</Text>
        </Row>
      )}
      <Spacer />

      {/* Channel sessions */}
      <SectionHeading title="Channel sessions" />
      {cs.kind === 'ok' ? (
        <>
          <Row icon={<StatusIcon kind="ok" />} label="sessions dir">
            {tildify(cs.path)}
          </Row>
          <Sub>{cs.activeCount} active session file(s)</Sub>
        </>
      ) : (
        <>
          <Row icon={<StatusIcon kind="dot" />} label="sessions dir">
            <Text dimColor>{tildify(cs.path)}</Text>
          </Row>
          <Sub>not created yet — start a Claude Code session with spaghetti-channel</Sub>
        </>
      )}
      <Spacer />
    </Box>
  );
}
