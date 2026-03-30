/**
 * SearchInput — Simple search text input (no autocomplete, no command registry)
 *
 * Search text input overlay for filtering views.
 * Renders: HRule, prompt line with input buffer, HRule
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { HRule } from './chrome.js';

// ─── Props ────────────────────────────────────────────────────────────

export interface SearchInputProps {
  onSearch: (query: string) => void;
  onCancel: () => void;
  placeholder?: string;
}

// ─── SearchInput Component ────────────────────────────────────────────

export function SearchInput({ onSearch, onCancel, placeholder }: SearchInputProps): React.ReactElement {
  const [buffer, setBuffer] = useState('');

  useInput((ch, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      if (buffer.trim().length > 0) {
        onSearch(buffer.trim());
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (buffer.length === 0) {
        onCancel();
      } else {
        setBuffer((prev) => prev.slice(0, -1));
      }
      return;
    }

    // Printable character — append to buffer
    if (ch && !key.ctrl && !key.meta) {
      setBuffer((prev) => prev + ch);
    }
  });

  const displayText = buffer.length > 0
    ? buffer
    : (placeholder ? <Text dimColor>{placeholder}</Text> : null);

  return (
    <Box flexDirection="column">
      <HRule />
      <Box>
        <Text>{'  \u276F search: '}</Text>
        {typeof displayText === 'string' ? <Text>{displayText}</Text> : displayText}
        <Text color="gray">{'\u2588'}</Text>
        <Box flexGrow={1} />
        <Text dimColor>Esc cancel  </Text>
      </Box>
      <HRule />
    </Box>
  );
}
