/**
 * Script import contract (the inverse of `exporters/`).
 *
 * An importer reads a Playwright or raw-CDP script and recovers a
 * {@link FlowModel}. Two classes of input are supported:
 *
 * - **Scripts produced by the exporters** (recognised by the `AUTO-GENERATED`
 *   banner): step ids and types come from the `// <id>: <type>` anchors, so the
 *   recovered flow re-exports byte-for-byte. Fields the exporters do not emit
 *   (`manual.resolveWhen`, `waitForPage.timeout`, …) cannot be recovered.
 * - **Hand-written scripts**: any statement matching the recognised vocabulary
 *   is imported, ids are synthesised, and everything else is reported through
 *   {@link ImportResult.warnings} instead of being dropped silently.
 *
 * Scripts are parsed as data. They are never evaluated.
 */
import type { FlowModel } from '../flow/schema.js';

/** Supported import targets, mirroring `ExportTarget`. */
export type ImportTarget = 'playwright' | 'raw-cdp';

/** Options for {@link importFlow} and the per-target importers. */
export interface ImportOptions {
  /** Override the flow id (defaults to the id in the script header). */
  id?: string;
  /** Override the flow name (defaults to the name in the script header). */
  name?: string;
}

/** A construct that could not be mapped onto a step. */
export interface ImportWarning {
  /** 1-based line in the source script. */
  line: number;
  /** Human readable explanation. */
  message: string;
  /** Offending source snippet, when useful. */
  snippet?: string;
}

/** Counters describing what an import produced. */
export interface ImportStats {
  /** Top-level statements inspected in the script body. */
  statements: number;
  /** Steps produced, including nested ones. */
  steps: number;
  /** Number of {@link ImportWarning} entries. */
  warnings: number;
}

/** Result of importing a script. */
export interface ImportResult {
  /** The recovered flow. Always passes `flowModelSchema`. */
  flow: FlowModel;
  /** Non-fatal problems, in source order. */
  warnings: ImportWarning[];
  /** True when the script carried the RoboBrowser export banner. */
  generated: boolean;
  /** Import counters. */
  stats: ImportStats;
}
