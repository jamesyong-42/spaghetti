import type { SpaghettiBridge } from '@shared/ipc';

declare global {
  interface Window {
    spaghetti: SpaghettiBridge;
  }
}

export {};
