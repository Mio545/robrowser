/**
 * pino logger factory (spec 2 / 14).
 *
 * Business code never calls `console.log`; it receives a logger through the
 * dependency bag. This module is the single place a pino instance is created.
 */
import { pino, type Logger } from 'pino';
import type { LoggerPort } from '@robrowser/core';

/** Options accepted by {@link createLogger}. */
export interface LoggerOptions {
  level?: string;
  /** Pretty-print (development) or emit newline-delimited JSON (production). */
  pretty?: boolean;
  /** Extra fields merged into every record. */
  base?: Record<string, unknown>;
}

/**
 * Create the process logger.
 *
 * @param options - Level / formatting / base fields.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: options.level ?? 'info',
    base: options.base ?? undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Adapt a pino logger to the core {@link LoggerPort} contract.
 *
 * The core port uses `(message, data)`; pino's conventional order is
 * `(obj, msg)`, so the adapter swaps them.
 */
export function toLoggerPort(logger: Logger): LoggerPort {
  return {
    debug: (message, data) => (data ? logger.debug(data, message) : logger.debug(message)),
    info: (message, data) => (data ? logger.info(data, message) : logger.info(message)),
    warn: (message, data) => (data ? logger.warn(data, message) : logger.warn(message)),
    error: (message, data) => (data ? logger.error(data, message) : logger.error(message)),
  };
}
