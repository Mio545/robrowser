/**
 * Runtime configuration, validated with zod (spec 10 / 14).
 *
 * Every value can be supplied through an environment variable so the same image
 * runs in development, CI and production. Defaults are chosen to be safe
 * (localhost-only bind, no secrets baked in).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Parsed, validated environment. */
export const serverConfigSchema = z.object({
  /** HTTP bind host. Defaults to loopback so a stray `serve` is not exposed. */
  HOST: z.string().default('127.0.0.1'),
  /** HTTP port. */
  PORT: z.coerce.number().int().positive().default(8080),
  /** Directory holding flows, artefacts and the SQLite database. */
  RUN_DIR: z.string().default('./run'),
  /**
   * Directory that relative `goto` URLs in *submitted* flows are resolved
   * against. Flows loaded from disk use their own directory instead (the
   * loader overrides this). Empty means "auto-detect the repository `flows/`".
   */
  FLOWS_DIR: z.string().default(''),
  /** Chromium/Chrome executable override. */
  CHROME_PATH: z.string().optional(),
  /** Force headless (`new`) mode; `false` runs headful (Xvfb). */
  HEADLESS: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  /** Extra Chromium flags, comma separated (e.g. `--no-sandbox,--disable-gpu`). */
  CHROME_ARGS: z.string().default(''),
  /** Secret used to sign takeover tickets. Required in production. */
  SECRET: z.string().default('dev-insecure-secret-change-me'),
  /** Public base URL of this server, used to build takeover links. */
  PUBLIC_URL: z.string().default('http://127.0.0.1:8080'),
  /** Takeover ticket lifetime, in seconds. */
  TAKEOVER_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /** Notification channels requested when a flow does not specify any. */
  NOTIFY_CHANNELS: z.string().default('log'),
  /** Webhook URL for the `webhook` notification channel. */
  WEBHOOK_URL: z.string().optional(),
  /** SMTP connection string for the `email` channel. */
  SMTP_URL: z.string().optional(),
  /** Default notification recipient. */
  NOTIFY_TO: z.string().optional(),
  /** Maximum concurrent worker processes. */
  MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Per-task timeout in milliseconds. */
  TASK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
  /** Queue retry budget for failed tasks. */
  TASK_RETRIES: z.coerce.number().int().nonnegative().default(1),
  /** pino log level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Bind the takeover page to a single operator (first wins). */
  TAKEOVER_SINGLE_CLIENT: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
});

/** Validated configuration object. */
export type ServerConfig = z.infer<typeof serverConfigSchema>;

/** Parse an environment record into a {@link ServerConfig}. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  const config = parsed.data;
  // Resolve FLOWS_DIR once so every worker gets an absolute base directory.
  // An empty value means: walk up from the cwd to the nearest \`flows/\` dir.
  const configured = config.FLOWS_DIR.trim();
  config.FLOWS_DIR = configured.length > 0 ? resolve(configured) : detectFlowsDir();
  return config;
}

/**
 * Locate the repository \`flows/\` directory by walking up from the cwd.
 *
 * @returns An absolute path (falls back to \`<cwd>/flows\`).
 */
export function detectFlowsDir(startDir: string = process.cwd()): string {
  let cursor = resolve(startDir);
  for (;;) {
    const candidate = join(cursor, 'flows');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) return join(resolve(startDir), 'flows');
    cursor = parent;
  }
}

/** Split the comma-separated `CHROME_ARGS` into an argv array. */
export function chromeArgs(config: ServerConfig): string[] {
  return config.CHROME_ARGS.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Split the comma-separated `NOTIFY_CHANNELS` into a list. */
export function notifyChannels(config: ServerConfig): string[] {
  return config.NOTIFY_CHANNELS.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
