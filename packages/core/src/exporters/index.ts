/**
 * Script exporters sharing the FlowModel intermediate representation (spec 5.5).
 */
export { exportPlaywright, type ExportOptions } from './playwright.js';
export { exportRawCdp, type RawCdpOptions } from './raw-cdp.js';

import type { FlowModel } from '../flow/schema.js';
import { ExportError } from '../errors.js';
import { exportPlaywright, type ExportOptions } from './playwright.js';
import { exportRawCdp, type RawCdpOptions } from './raw-cdp.js';

/** Supported export targets. */
export type ExportTarget = 'playwright' | 'raw-cdp';

/** Options union keyed by target. */
export interface ExportByTargetOptions {
  playwright?: ExportOptions;
  'raw-cdp'?: RawCdpOptions;
}

/**
 * Dispatch helper used by the CLI / desktop export dialog.
 *
 * @param flow - Flow to export.
 * @param target - Target language/runtime.
 * @param options - Target specific options (typed per target).
 * @returns Generated script source.
 */
export function exportFlow(
  flow: FlowModel,
  target: ExportTarget,
  options: ExportByTargetOptions = {},
): string {
  switch (target) {
    case 'playwright':
      return exportPlaywright(flow, options.playwright ?? {});
    case 'raw-cdp':
      return exportRawCdp(flow, options['raw-cdp'] ?? {});
    default: {
      const exhaustive: never = target;
      throw new ExportError(`Unknown export target: ${String(exhaustive)}`);
    }
  }
}
