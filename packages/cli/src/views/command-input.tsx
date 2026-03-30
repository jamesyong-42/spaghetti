/**
 * CommandInput — slash command input with live autocomplete
 *
 * Renders a prompt line with an input buffer and a suggestion list
 * below it. Handles character input, backspace, arrow key navigation,
 * Tab completion, Enter execution, and Esc cancellation.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { HRule } from './chrome.js';
import { matchCommands, type CommandDef } from './commands.js';

// ─── Command History (module-level, persists across command mode entries) ──

const MAX_HISTORY = 20;
const commandHistory: string[] = [];

function pushHistory(cmd: string): void {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  // Remove duplicate if it's already the most recent
  if (commandHistory.length > 0 && commandHistory[commandHistory.length - 1] === trimmed) return;
  commandHistory.push(trimmed);
  if (commandHistory.length > MAX_HISTORY) {
    commandHistory.shift();
  }
}

// ─── Props ────────────────────────────────────────────────────────────

export interface CommandInputProps {
  onExecute: (commandName: string, args: string) => void;
  onCancel: () => void;
}

// ─── Suggestion Row ───────────────────────────────────────────────────

const COLUMN_WIDTH = 22; // width for the command name column

function SuggestionRow({
  command,
  selected,
}: {
  command: CommandDef;
  selected: boolean;
}): React.ReactElement {
  const label = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
  const padded = label.padEnd(COLUMN_WIDTH);

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined} bold={selected}>
        {'  '}{padded}
      </Text>
      <Text dimColor>{command.description}</Text>
    </Box>
  );
}

// ─── CommandInput Component ───────────────────────────────────────────

const MAX_VISIBLE_SUGGESTIONS = 8;

export function CommandInput({ onExecute, onCancel }: CommandInputProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  // History navigation: -1 means "not browsing history" (editing new input)
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Stash the user's in-progress input when they start browsing history
  const [stashedInput, setStashedInput] = useState('');
  const { stdout } = useStdout();
  const _cols = stdout?.columns ?? 80;

  // Space shorthand: "/ text" → search mode, hide suggestions
  const isSearchShorthand = input.startsWith(' ');

  // Derive the command part (before any space) for matching
  const commandPart = useMemo(() => {
    if (isSearchShorthand) return '';
    const spaceIdx = input.indexOf(' ');
    return spaceIdx === -1 ? input : input.slice(0, spaceIdx);
  }, [input, isSearchShorthand]);

  // Filter suggestions
  const filtered = useMemo(() => {
    if (isSearchShorthand) return [];
    const matches = matchCommands(commandPart);

    // If input contains a space (user is typing args) and the command part
    // exactly matches a single command name, hide suggestions
    if (input.includes(' ') && !isSearchShorthand) {
      const exactMatch = matches.find((m) => m.name === commandPart.toLowerCase());
      if (exactMatch) return [];
    }

    return matches;
  }, [commandPart, input, isSearchShorthand]);

  // Clamp selected suggestion when filtered list changes
  const clampedSelected = filtered.length === 0 ? -1 : Math.min(selectedSuggestion, filtered.length - 1);

  // Key handling
  useInput((ch, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (clampedSelected >= 0 && filtered[clampedSelected]) {
        // Fill command name into input
        const cmd = filtered[clampedSelected];
        setInput(cmd.name + (cmd.args ? ' ' : ''));
        setSelectedSuggestion(-1);
        setHistoryIndex(-1);
        return;
      }

      // Save to history before executing
      pushHistory(input);

      // Execute whatever is typed
      if (isSearchShorthand) {
        // "/ text" → search shorthand
        onExecute('search', input.slice(1).trim());
      } else {
        // Parse command from input
        const trimmed = input.trim();
        const spaceIdx = trimmed.indexOf(' ');
        const cmdName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
        onExecute(cmdName, args);
      }
      return;
    }

    if (key.tab) {
      if (filtered.length > 0) {
        const target = clampedSelected >= 0 ? filtered[clampedSelected] : filtered[0];
        setInput(target.name + (target.args ? ' ' : ''));
        setSelectedSuggestion(-1);
      }
      return;
    }

    if (key.upArrow) {
      if (filtered.length > 0) {
        // Navigate suggestions when suggestion list is visible
        setSelectedSuggestion((s) => Math.max(s - 1, -1));
      } else if (commandHistory.length > 0) {
        // No suggestions — recall from command history
        if (historyIndex === -1) {
          // Starting to browse history — stash current input
          setStashedInput(input);
          const idx = commandHistory.length - 1;
          setHistoryIndex(idx);
          setInput(commandHistory[idx]);
        } else if (historyIndex > 0) {
          const idx = historyIndex - 1;
          setHistoryIndex(idx);
          setInput(commandHistory[idx]);
        }
        setSelectedSuggestion(-1);
      }
      return;
    }

    if (key.downArrow) {
      if (filtered.length > 0) {
        // Navigate suggestions when suggestion list is visible
        setSelectedSuggestion((s) => Math.min(s + 1, filtered.length - 1));
      } else if (historyIndex >= 0) {
        // No suggestions — move forward through command history
        if (historyIndex < commandHistory.length - 1) {
          const idx = historyIndex + 1;
          setHistoryIndex(idx);
          setInput(commandHistory[idx]);
        } else {
          // Past the end of history — restore stashed input
          setHistoryIndex(-1);
          setInput(stashedInput);
        }
        setSelectedSuggestion(-1);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (input.length === 0) {
        onCancel();
      } else {
        setInput((prev) => prev.slice(0, -1));
        setSelectedSuggestion(-1);
        setHistoryIndex(-1);
      }
      return;
    }

    // Printable character — append to input
    if (ch && !key.ctrl && !key.meta) {
      setInput((prev) => prev + ch);
      setSelectedSuggestion(-1);
      setHistoryIndex(-1);
    }
  });

  // Visible suggestions (capped)
  const visibleSuggestions = filtered.slice(0, MAX_VISIBLE_SUGGESTIONS);

  return (
    <Box flexDirection="column">
      <HRule />
      <Text>{'❯ /'}{input}<Text color="gray">{'█'}</Text></Text>
      <HRule />
      {visibleSuggestions.map((cmd, i) => (
        <SuggestionRow key={cmd.name} command={cmd} selected={i === clampedSelected} />
      ))}
    </Box>
  );
}
