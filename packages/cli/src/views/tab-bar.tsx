/**
 * TabBar — Shared component for rendering tab headers with active/inactive styling
 *
 * Pure display component: the parent handles key input and calls onTabChange.
 */

import React from 'react';
import { Box, Text } from 'ink';

// ─── Props ────────────────────────────────────────────────────────────

export interface TabBarProps {
  tabs: string[];
  activeIndex: number;
  onTabChange: (index: number) => void;
}

// ─── TabBar Component ─────────────────────────────────────────────────

export function TabBar({ tabs, activeIndex }: TabBarProps): React.ReactElement {
  return (
    <Box>
      <Text>  </Text>
      {tabs.map((tab, i) => (
        <React.Fragment key={tab}>
          {i > 0 && <Text dimColor> {'\u2502'} </Text>}
          {i === activeIndex ? (
            <Text bold color="white">{tab}</Text>
          ) : (
            <Text dimColor>{tab}</Text>
          )}
        </React.Fragment>
      ))}
    </Box>
  );
}
