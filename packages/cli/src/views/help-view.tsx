/**
 * HelpView — Static help screen listing keybindings
 *
 * Any key dismisses it (pops back to previous view).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useViewNav } from './context.js';

export function HelpView(): React.ReactElement {
  const nav = useViewNav();

  // Any key dismisses
  useInput(
    () => {
      nav.pop();
    },
    { isActive: !nav.searchMode },
  );

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text> </Text>
      <Text bold>Navigation</Text>
      <Text> {'↑ ↓'.padEnd(14)}Move selection up/down</Text>
      <Text> {'← →'.padEnd(14)}Switch tabs</Text>
      <Text> {'Enter'.padEnd(14)}Open / drill into selected item</Text>
      <Text> {'Esc'.padEnd(14)}Go back to previous view</Text>
      <Text> {'q'.padEnd(14)}Quit spaghetti</Text>
      <Text> </Text>
      <Text bold>Search</Text>
      <Text> {'/'.padEnd(14)}Open search bar</Text>
      <Text> {'Enter'.padEnd(14)}Execute search</Text>
      <Text> {'Esc'.padEnd(14)}Cancel search</Text>
      <Text> </Text>
      <Text bold>Message Filters</Text>
      <Text dimColor> Messages tab only</Text>
      <Text>
        {' '}
        {'1'.padEnd(4)}user {'2'.padEnd(4)}claude {'3'.padEnd(4)}thinking
      </Text>
      <Text>
        {' '}
        {'4'.padEnd(4)}tools {'5'.padEnd(4)}system {'6'.padEnd(4)}internal
      </Text>
      <Text> </Text>
    </Box>
  );
}
