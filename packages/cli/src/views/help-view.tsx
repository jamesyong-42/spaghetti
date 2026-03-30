/**
 * HelpView — Static help screen listing keybindings and commands
 *
 * Any key dismisses it (pops back to previous view).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useViewNav } from './context.js';
import { COMMANDS } from './commands.js';

export function HelpView(): React.ReactElement {
  const nav = useViewNav();

  // Any key dismisses
  useInput(() => {
    nav.pop();
  }, { isActive: !nav.commandMode });

  // Build commands section dynamically from COMMANDS (excluding quit)
  const commandLines = COMMANDS.filter((c) => c.name !== 'quit').map((c) => {
    const name = `/${c.name}${c.args ? ` ${c.args}` : ''}`;
    const aliases = c.aliases.map((a) => `/${a}`).join(', ');
    return { name, description: c.description, aliases };
  });

  // Compute column widths for alignment
  const maxName = Math.max(...commandLines.map((c) => c.name.length));
  const maxDesc = Math.max(...commandLines.map((c) => c.description.length));

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text> </Text>
      <Text bold>Navigation</Text>
      <Text>  {'↑ ↓'.padEnd(16)}Move selection up/down</Text>
      <Text>  {'Enter'.padEnd(16)}Open / drill into selected item</Text>
      <Text>  {'Esc'.padEnd(16)}Go back to previous view</Text>
      <Text>  {'q'.padEnd(16)}Quit spaghetti</Text>
      <Text> </Text>
      <Text bold>Commands</Text>
      <Text dimColor>  Press / then type a command</Text>
      {commandLines.map((c) => (
        <Text key={c.name}>
          {'  '}{c.name.padEnd(maxName + 4)}{c.description.padEnd(maxDesc + 4)}{c.aliases}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Message Filters</Text>
      <Text dimColor>  Messages view only</Text>
      <Text>  {'1'.padEnd(4)}user      {'2'.padEnd(4)}claude      {'3'.padEnd(4)}thinking</Text>
      <Text>  {'4'.padEnd(4)}tools     {'5'.padEnd(4)}system      {'6'.padEnd(4)}internal</Text>
      <Text> </Text>
    </Box>
  );
}
