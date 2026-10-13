/**
 * CLI argument parsing (spec 7.1).
 *
 * Parsing is isolated from `cli.ts` so it can be unit tested without spawning a
 * process. The grammar is intentionally small and zod-validated:
 *
 *   automate run <flow.json> [--headless|--headful] [--chrome <path>] [--out <dir>] [--var k=v]
 *   automate validate <flow.json>
 *   automate export <flow.json> --target playwright|raw-cdp [--out <file>]
 *   automate import <script.js> [--target playwright|raw-cdp] [--out <flow.json>]
 *   automate serve [--port <n>] [--host <h>]
 *   automate takeover <flow.json> [--headless]         # CLI run that allows takeover
 *   automate credentials list
 *   automate credentials set <name> [--username <u>] [--url <url>] [--password <p> | --password-env <VAR>]
 *   automate credentials delete <name>
 */
import { z } from 'zod';
import { ValidationError } from '@robrowser/core';

/** Parsed command variants. */
export type CliCommand =
  | {
      kind: 'run';
      file: string;
      headless?: boolean;
      chrome?: string;
      out?: string;
      vars: Record<string, string>;
      autoManual: boolean;
      takeover: boolean;
    }
  | { kind: 'validate'; file: string }
  | { kind: 'export'; file: string; target: 'playwright' | 'raw-cdp'; out?: string }
  | {
      kind: 'import';
      file: string;
      /** Absent when the flavour should be sniffed from the script itself. */
      target?: 'playwright' | 'raw-cdp';
      out?: string;
    }
  | { kind: 'serve'; host?: string; port?: number }
  | { kind: 'credentials-list' }
  | {
      kind: 'credentials-set';
      key: string;
      username?: string;
      password?: string;
      /** Name of an environment variable to read the password from. */
      passwordEnv?: string;
      url?: string;
    }
  | { kind: 'credentials-delete'; key: string }
  | { kind: 'help' }
  | { kind: 'version' };

const varSchema = z.record(z.string());

/** Result of parsing argv. */
export interface ParseResult {
  command: CliCommand;
  /** Non-fatal notes (e.g. unknown flags were ignored). */
  warnings: string[];
}

/**
 * Parse a `process.argv.slice(2)` style array.
 *
 * @param argv - Arguments after the executable / script name.
 * @returns The structured command.
 * @throws {ValidationError} When the arguments are structurally invalid.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const warnings: string[] = [];
  const args = [...argv];

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { command: { kind: 'help' }, warnings };
  }
  if (args[0] === '--version' || args[0] === '-v') {
    return { command: { kind: 'version' }, warnings };
  }

  const sub = args.shift()!;
  const { flags, positionals } = splitFlags(args);

  switch (sub) {
    case 'run':
    case 'takeover': {
      const file = positionals[0];
      if (!file) throw new ValidationError(`Usage: automate ${sub} <flow.json> [options]`);
      const vars = parseVarFlags(normaliseFlags(flags.var));
      const headless =
        flags.headful !== undefined ? false : flags.headless !== undefined ? true : undefined;
      return {
        command: {
          kind: 'run',
          file,
          vars,
          autoManual: flags['auto-manual'] !== undefined,
          takeover: sub === 'takeover' || flags.takeover !== undefined,
          ...(headless !== undefined ? { headless } : {}),
          ...(typeof flags.chrome === 'string' ? { chrome: flags.chrome } : {}),
          ...(typeof flags.out === 'string' ? { out: flags.out } : {}),
        },
        warnings,
      };
    }
    case 'validate': {
      const file = positionals[0];
      if (!file) throw new ValidationError('Usage: automate validate <flow.json>');
      return { command: { kind: 'validate', file }, warnings };
    }
    case 'export': {
      const file = positionals[0];
      if (!file)
        throw new ValidationError('Usage: automate export <flow.json> --target playwright|raw-cdp');
      const targetRaw = flags.target ?? positionals[1];
      if (targetRaw !== 'playwright' && targetRaw !== 'raw-cdp') {
        throw new ValidationError('export requires --target playwright|raw-cdp');
      }
      return {
        command: {
          kind: 'export',
          file,
          target: targetRaw,
          ...(typeof flags.out === 'string' ? { out: flags.out } : {}),
        },
        warnings,
      };
    }
    case 'import': {
      const file = positionals[0];
      if (!file) {
        throw new ValidationError(
          'Usage: automate import <script.js> [--target playwright|raw-cdp] [--out flow.json]',
        );
      }
      const targetRaw = flags.target ?? positionals[1];
      if (targetRaw !== undefined && targetRaw !== 'playwright' && targetRaw !== 'raw-cdp') {
        throw new ValidationError('import requires --target playwright|raw-cdp');
      }
      return {
        command: {
          kind: 'import',
          file,
          ...(targetRaw !== undefined ? { target: targetRaw } : {}),
          ...(typeof flags.out === 'string' ? { out: flags.out } : {}),
        },
        warnings,
      };
    }
    case 'serve': {
      const port = flags.port ? Number(flags.port) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        throw new ValidationError(`Invalid --port value: ${flags.port}`);
      }
      return {
        command: {
          kind: 'serve',
          ...(typeof flags.host === 'string' ? { host: flags.host } : {}),
          ...(port !== undefined ? { port } : {}),
        },
        warnings,
      };
    }
    case 'credentials': {
      const action = positionals[0];
      if (action === 'list') {
        return { command: { kind: 'credentials-list' }, warnings };
      }
      if (action === 'set') {
        const key = positionals[1];
        if (!key) {
          throw new ValidationError(
            'Usage: automate credentials set <name> [--username <u>] [--url <url>] ' +
              '[--password <p> | --password-env <VAR>]',
          );
        }
        const password = typeof flags.password === 'string' ? flags.password : undefined;
        const passwordEnv =
          typeof flags['password-env'] === 'string' ? flags['password-env'] : undefined;
        return {
          command: {
            kind: 'credentials-set',
            key,
            ...(typeof flags.username === 'string' ? { username: flags.username } : {}),
            ...(password !== undefined ? { password } : {}),
            ...(passwordEnv !== undefined ? { passwordEnv } : {}),
            ...(typeof flags.url === 'string' ? { url: flags.url } : {}),
          },
          warnings,
        };
      }
      if (action === 'delete') {
        const key = positionals[1];
        if (!key) throw new ValidationError('Usage: automate credentials delete <name>');
        return { command: { kind: 'credentials-delete', key }, warnings };
      }
      throw new ValidationError('Usage: automate credentials list|set|delete');
    }
    default:
      throw new ValidationError(`Unknown command "${sub}". Run "automate help" for usage.`);
  }
}

/** Split `--flag value`, `--flag=value`, and bare positionals. */
function splitFlags(args: readonly string[]): {
  flags: Record<string, string | string[]>;
  positionals: string[];
} {
  const flags: Record<string, string | string[]> = {};
  const positionals: string[] = [];

  const setFlag = (name: string, value: string): void => {
    const existing = flags[name];
    if (existing === undefined) {
      flags[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      flags[name] = [existing, value];
    }
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      setFlag(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      setFlag(name, next);
      index += 1;
    } else {
      setFlag(name, 'true');
    }
  }
  return { flags, positionals };
}

/** Normalise a flag value that may repeat into an array. */
function normaliseFlags(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parse repeated --var k=v flags into a record. */
export function parseVarFlags(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of values) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new ValidationError(`Invalid --var entry "${entry}"; expected key=value`);
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return varSchema.parse(out);
}

/** Usage text shown by `automate help` and on argument errors. */
export const USAGE = `automate — RoboBrowser CLI

Usage:
  automate run <flow.json> [--headless|--headful] [--chrome <path>] [--out <dir>] [--var k=v]
  automate validate <flow.json>
  automate export <flow.json> --target playwright|raw-cdp [--out <file>]
  automate import <script.js> [--target playwright|raw-cdp] [--out <flow.json>]
  automate serve [--host <host>] [--port <port>]
  automate takeover <flow.json> [--headless] [--out <dir>]
  automate credentials list
  automate credentials set <name> [--username <u>] [--url <url>] [--password-env <VAR>]
  automate credentials delete <name>

Environment:
  CHROME_PATH   Chromium/Chrome executable override
  RUN_DIR       Directory for artefacts and checkpoints (default ./run)
  SECRET        Signing secret for takeover tickets
  ROBO_OUT      Output directory used by exported scripts
  ROBO_CREDENTIALS_FILE  Web-login vault file (default <RUN_DIR>/credentials.json)
  ROBO_CREDENTIALS_KEY   Vault encryption key (falls back to SECRET)
`;
