/**
 * Script importers sharing the FlowModel intermediate representation.
 *
 * The inverse of `exporters/`: reads a Playwright or raw-CDP script and
 * recovers the flow it was generated from. Scripts are parsed as data and are
 * never evaluated, so importing an untrusted script is safe.
 */
export { importPlaywright } from './playwright.js';
export { importRawCdp } from './raw-cdp.js';
export type {
  ImportOptions,
  ImportResult,
  ImportStats,
  ImportTarget,
  ImportWarning,
} from './types.js';

import { ImportError } from '../errors.js';
import type { ImportOptions, ImportResult, ImportTarget } from './types.js';
import { importPlaywright } from './playwright.js';
import { importRawCdp } from './raw-cdp.js';

/** Options union keyed by target. */
export interface ImportByTargetOptions {
  playwright?: ImportOptions;
  'raw-cdp'?: ImportOptions;
}

/**
 * Dispatch helper used by the CLI / desktop import dialog.
 *
 * @param source - Script text.
 * @param target - Script flavour to read.
 * @param options - Target specific options (typed per target).
 * @returns The recovered flow plus warnings.
 * @throws {ImportError} When the script cannot be interpreted.
 */
export function importFlow(
  source: string,
  target: ImportTarget,
  options: ImportByTargetOptions = {},
): ImportResult {
  switch (target) {
    case 'playwright':
      return importPlaywright(source, options.playwright ?? {});
    case 'raw-cdp':
      return importRawCdp(source, options['raw-cdp'] ?? {});
    default: {
      const exhaustive: never = target;
      throw new ImportError(`Unknown import target: ${String(exhaustive)}`);
    }
  }
}

/**
 * Sniff the script flavour from its imports and API calls.
 *
 * @param source - Script text.
 * @returns The best guess, or `null` when neither flavour is recognisable.
 */
export function detectImportTarget(source: string): ImportTarget | null {
  if (
    /require\(\s*['"]playwright['"]\s*\)/.test(source) ||
    /from\s+['"]playwright['"]/.test(source) ||
    source.includes('chromium.launch(') ||
    source.includes('page.locator(')
  ) {
    return 'playwright';
  }
  if (source.includes('Page.navigate') || source.includes('openCdp(') || source.includes('CDP_WS_URL')) {
    return 'raw-cdp';
  }
  return null;
}
