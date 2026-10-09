import type { RoboBrowserApi } from '../shared/types';

declare global {
  interface Window {
    /** Injected by the preload script; the only privileged surface available. */
    robrowser: RoboBrowserApi & { navigate(url: string): Promise<{ ok: boolean }> };
  }
}

export {};
