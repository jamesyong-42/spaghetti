/**
 * ViewNav React context — provides navigation callbacks to all views
 */

import React from 'react';
import type { ViewNav } from './types.js';

const ViewNavContext = React.createContext<ViewNav>(null!);

export const ViewNavProvider = ViewNavContext.Provider;

export function useViewNav(): ViewNav {
  return React.useContext(ViewNavContext);
}
