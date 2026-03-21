import React, { createContext, useContext } from 'react';
import type { SpaghettiAPI } from '@spaghetti/core';

const SpaghettiContext = createContext<SpaghettiAPI | null>(null);

export interface SpaghettiProviderProps {
  api: SpaghettiAPI;
  children: React.ReactNode;
}

export function SpaghettiProvider({ api, children }: SpaghettiProviderProps) {
  return (
    <SpaghettiContext.Provider value={api}>
      {children}
    </SpaghettiContext.Provider>
  );
}

export function useSpaghettiAPI(): SpaghettiAPI {
  const api = useContext(SpaghettiContext);
  if (!api) {
    throw new Error('useSpaghettiAPI must be used within a SpaghettiProvider');
  }
  return api;
}
