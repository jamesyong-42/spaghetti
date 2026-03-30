/**
 * Wordmark — 3-line half-block art for the Spaghetti brand
 */

import React from 'react';
import { Text } from 'ink';

/* eslint-disable no-irregular-whitespace */
const LINES = [
  '▄▀▀ █▀█ ▄▀▄ █▀▀ █ █ █▀▀ ▀█▀ ▀█▀ █',
  '▀▄▄ █▀▀ █▀█ █ █ █▀█ █▀   █   █  █',
  '▄▄▀ █   █ █ ▀▀▀ ▀ ▀ ▀▀▀  ▀   ▀  ▀',
];

export function Wordmark(): React.ReactElement {
  return (
    <>
      {LINES.map((line, i) => (
        <Text key={i} bold>{line}</Text>
      ))}
    </>
  );
}
