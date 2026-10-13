#!/usr/bin/env node
/**
 * RoboBrowser CLI (spec 7.1).
 *
 *   automate run      <flow.json> [--headless|--headful] [--chrome <path>] [--out <dir>] [--var k=v]
 *   automate validate <flow.json>
 *   automate export   <flow.json> --target playwright|raw-cdp [--out file]
 *   automate import   <script.js> [--target playwright|raw-cdp] [--out flow.json]
 *   automate serve    [--host <host>] [--port <port>]
 *   automate takeover <flow.json> [--headless] [--out <dir>] [--var k=v]
 *   automate credentials list|set|delete
 *
 * Exit codes: 0 on success, non-zero on failure. Every run prints a structured
 * JSON summary on stdout so CI can consume it; diagnostics go to stderr via pino
 * (except for the summary, which is explicitly machine-readable stdout output).
 */
import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  detectImportTarget,
  exportFlow,
  importFlow,
  ImportError,
  loadFlow,
  RoboError,
  saveFlow,
  stringifyFlow,
  toRoboError,
  type FlowModel,
} from '@robrowser/core';
import { parseArgs, USAGE } from './cli-args.js';
import { resolveFlowPath } from './cli-paths.js';
import { loadConfig, notifyChannels } from './env.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';
import { FileCredentialStore, resolveCredentialVault } from './credentials.js';
import { TicketService } from './takeover/tokens.js';
import { TakeoverService, RemoteTakeoverHandler } from './takeover/service.js';
import { buildNotifier, deliverRunFailure, warnMissingChannels } from './notify/build.js';
import { createServe } from './serve.js';

/** Exit code used for validation / usage errors (distinct from runtime errors). */
const EXIT_VALIDATION = 2;

/** Machine-readable summary written to stdout at the end of `run`. */
interface RunSummary {
  command: 'run';
  status: 'success' | 'failed';
  flow: { id: string; name: string; file: string };
  runId: string;
  stepsExecuted: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  artifacts: string[];
  variables: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * CLI entry point.
 *
 * @param argv - Arguments after `node cli.js` (defaults to `process.argv.slice(2)`).
 * @returns Process exit code.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(`${robo.message}\n\n${USAGE}\n`);
    return EXIT_VALIDATION;
  }

  for (const warning of parsed.warnings) process.stderr.write(`warning: ${warning}\n`);
  const command = parsed.command;

  switch (command.kind) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'version':
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    case 'validate':
      return validateCommand(command.file);
    case 'export':
      return exportCommand(command.file, command.target, command.out);
    case 'import':
      return importCommand(command.file, command.target, command.out);
    case 'run':
      return runCommand(command);
    case 'serve':
      return serveCommand(command);
    case 'credentials-list':
      return credentialsListCommand();
    case 'credentials-set':
      return credentialsSetCommand(command);
    case 'credentials-delete':
      return credentialsDeleteCommand(command.key);
    default: {
      const exhaustive: never = command;
      process.stderr.write(`Unsupported command: ${JSON.stringify(exhaustive)}\n`);
      return EXIT_VALIDATION;
    }
  }
}

/* ------------------------------------------------------------------ validate */

async function validateCommand(file: string): Promise<number> {
  try {
    // Report the path that was actually loaded, not the cwd-joined one:
    // `pnpm --filter server cli validate flows/demo.json` runs with the package
    // directory as cwd, so `resolve(file)` would name a non-existent file.
    const flowPath = resolveFlowPath(file);
    const flow = await loadFlow(flowPath);
    process.stdout.write(
      `${JSON.stringify(
        {
          command: 'validate',
          status: 'ok',
          file: flowPath,
          flow: { id: flow.id, name: flow.name, version: flow.version, steps: countSteps(flow) },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'validate', status: 'invalid', error: robo.code, message: robo.message })}\n`,
    );
    return EXIT_VALIDATION;
  }
}

/* -------------------------------------------------------------------- export */

async function exportCommand(
  file: string,
  target: 'playwright' | 'raw-cdp',
  out: string | undefined,
): Promise<number> {
  try {
    const flowPath = resolveFlowPath(file);
    const flow = await loadFlow(flowPath);
    // Bake the flow directory so relative `goto` URLs in the exported script
    // resolve to the same file:// targets the engine used.
    const script = exportFlow(flow, target, {
      playwright: { flowDir: dirname(flowPath) },
      'raw-cdp': { flowDir: dirname(flowPath) },
    });
    if (out) {
      const absolute = resolve(out);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, script, 'utf8');
      process.stdout.write(
        `${JSON.stringify({ command: 'export', status: 'ok', target, file: absolute, bytes: script.length }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(script);
    }
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'export', status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return robo.code === 'VALIDATION_ERROR' || robo.code === 'FLOW_NOT_FOUND' ? EXIT_VALIDATION : 1;
  }
}

/* -------------------------------------------------------------------- import */

/**
 * `automate import <script.js> [--target playwright|raw-cdp] [--out flow.json]`
 *
 * Reads an exported (or hand-written) Playwright / raw-CDP script and recovers
 * the flow. The script is parsed as data and never evaluated. Without `--out`
 * the flow JSON is written to stdout so it can be piped.
 */
async function importCommand(
  file: string,
  target: 'playwright' | 'raw-cdp' | undefined,
  out: string | undefined,
): Promise<number> {
  try {
    const scriptPath = resolveFlowPath(file);
    const source = await readFile(scriptPath, 'utf8');
    const resolved = target ?? detectImportTarget(source);
    if (resolved === null) {
      throw new ImportError(
        `无法识别 ${scriptPath} 的脚本类型；请用 --target playwright|raw-cdp 指定`,
      );
    }

    const result = importFlow(source, resolved);
    for (const warning of result.warnings) {
      process.stderr.write(`warning: ${scriptPath}:${warning.line}: ${warning.message}\n`);
    }

    if (out) {
      const absolute = resolve(out);
      await saveFlow(absolute, result.flow);
      process.stdout.write(
        `${JSON.stringify(
          {
            command: 'import',
            status: 'ok',
            target: resolved,
            file: absolute,
            flow: { id: result.flow.id, name: result.flow.name, steps: countSteps(result.flow) },
            generated: result.generated,
            warnings: result.warnings.length,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(stringifyFlow(result.flow));
    }
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'import', status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return robo.code === 'VALIDATION_ERROR' ||
      robo.code === 'FLOW_NOT_FOUND' ||
      robo.code === 'IMPORT_ERROR'
      ? EXIT_VALIDATION
      : 1;
  }
}

/* -------------------------------------------------------------- credentials */

/**
 * Build the server-side vault from validated config.
 *
 * Shared by the `credentials` subcommands so `list` / `set` /
 * `delete` all touch the same file the workers read from. Key material
 * falls back to `SECRET`, matching `WorkerSupervisor`.
 */
function openCredentialStore(): { store: FileCredentialStore; file: string } {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.LOG_LEVEL, base: { scope: 'credentials' } });
  const { file, key } = resolveCredentialVault(config);
  const store = new FileCredentialStore({ file, key, logger });
  return { store, file };
}

/** `automate credentials list` — redacted metadata only. */
async function credentialsListCommand(): Promise<number> {
  try {
    const { store } = openCredentialStore();
    const entries = await store.list();
    process.stdout.write(
      `${JSON.stringify({ command: 'credentials', status: 'ok', action: 'list', entries }, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'credentials', status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return 1;
  }
}

/**
 * `automate credentials set <name> [--username <u>] [--url <url>]`
 *
 * The password is read from `--password-env <VAR>` by preference: passing a
 * secret as argv exposes it in the process list and the shell history.
 */
async function credentialsSetCommand(
  command: Extract<ReturnType<typeof parseArgs>['command'], { kind: 'credentials-set' }>,
): Promise<number> {
  try {
    const password =
      command.passwordEnv !== undefined ? process.env[command.passwordEnv] : command.password;
    if (command.passwordEnv !== undefined && password === undefined) {
      throw new Error('环境变量 ' + command.passwordEnv + ' 未设置，无法读取密码');
    }
    const { store, file } = openCredentialStore();
    const record = await store.set({
      key: command.key,
      ...(command.username !== undefined ? { username: command.username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(command.url !== undefined ? { url: command.url } : {}),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          command: 'credentials',
          status: 'ok',
          action: 'set',
          file,
          entry: {
            key: record.key,
            username: record.username,
            url: record.url,
            hasPassword: record.password !== undefined,
          },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'credentials', status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return robo.code === 'VALIDATION_ERROR' ? EXIT_VALIDATION : 1;
  }
}

/** `automate credentials delete <name>` */
async function credentialsDeleteCommand(key: string): Promise<number> {
  try {
    const { store } = openCredentialStore();
    const deleted = await store.delete(key);
    process.stdout.write(
      `${JSON.stringify({ command: 'credentials', status: 'ok', action: 'delete', key, deleted }, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ command: 'credentials', status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return 1;
  }
}

/* ----------------------------------------------------------------------- run */

async function runCommand(
  command: Extract<ReturnType<typeof parseArgs>['command'], { kind: 'run' }>,
): Promise<number> {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.LOG_LEVEL, base: { scope: 'cli' } });

  let flow: FlowModel;
  try {
    flow = await loadFlow(resolveFlowPath(command.file));
  } catch (error) {
    const robo = toRoboError(error);
    process.stderr.write(
      `${JSON.stringify({ status: 'failed', error: robo.code, message: robo.message })}\n`,
    );
    return EXIT_VALIDATION;
  }

  const runDir = resolve(command.out ?? join(config.RUN_DIR, 'runs', `${flow.id}-cli`));
  await mkdir(runDir, { recursive: true });

  const headless = command.headless ?? config.HEADLESS;
  const effectiveConfig = {
    ...config,
    HEADLESS: headless,
    RUN_DIR: runDir,
    ...(command.chrome ? { CHROME_PATH: command.chrome } : {}),
  };

  // The `takeover` command always wires the remote takeover handler; a plain
  // `run` uses it too when the flow declares a manual step, so an interactive
  // operator link is printed with the log notification channel.
  const tickets = new TicketService({
    secret: effectiveConfig.SECRET,
    ttlSeconds: effectiveConfig.TAKEOVER_TTL_SECONDS,
  });
  const notifier = buildNotifier(
    {
      ...(effectiveConfig.WEBHOOK_URL ? { webhookUrl: effectiveConfig.WEBHOOK_URL } : {}),
      ...(effectiveConfig.SMTP_URL ? { smtpUrl: effectiveConfig.SMTP_URL } : {}),
      ...(effectiveConfig.NOTIFY_TO ? { notifyTo: effectiveConfig.NOTIFY_TO } : {}),
      ...(effectiveConfig.FEISHU_WEBHOOK_URL
        ? { feishuWebhookUrl: effectiveConfig.FEISHU_WEBHOOK_URL }
        : {}),
      ...(effectiveConfig.FEISHU_SECRET ? { feishuSecret: effectiveConfig.FEISHU_SECRET } : {}),
      ...(effectiveConfig.DINGTALK_WEBHOOK_URL
        ? { dingtalkWebhookUrl: effectiveConfig.DINGTALK_WEBHOOK_URL }
        : {}),
      ...(effectiveConfig.DINGTALK_SECRET
        ? { dingtalkSecret: effectiveConfig.DINGTALK_SECRET }
        : {}),
    },
    logger,
  );
  const requestedChannels = notifyChannels(effectiveConfig);
  warnMissingChannels(notifier, requestedChannels, logger);

  // Construct the takeover service eagerly so the manual handler has no
  // lazy-init race against the first manual step.
  const service = new TakeoverService({
    logger,
    tickets,
    notifier,
    publicUrl: effectiveConfig.PUBLIC_URL,
    singleClient: effectiveConfig.TAKEOVER_SINGLE_CLIENT,
  });
  const manualHandler = new RemoteTakeoverHandler(service);

  // The run command is single-process, so the vault is built here rather than
  // forwarded over IPC the way the serve workers do. Resolve it from the
  // unmodified config: RUN_DIR above points at this run's artefact directory,
  // while the vault is shared with serve and the credentials subcommands.
  const vaultLocation = resolveCredentialVault(config);
  const credentialStore = new FileCredentialStore({
    file: vaultLocation.file,
    key: vaultLocation.key,
    logger,
  });

  const runtime = createRuntime({
    logger,
    config: effectiveConfig,
    credentialStore,
    ...(command.autoManual
      ? { manual: { request: async () => ({ status: 'resolved' as const, by: 'cli' }) } }
      : { manual: manualHandler }),
  });

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const started = Date.now();
  try {
    await runtime.start();
    const result = await runtime.run(flow, {
      runId: `${flow.id}-${Date.now().toString(36)}`,
      vars: command.vars,
      runDir,
      signal: controller.signal,
    });

    const summary: RunSummary = {
      command: 'run',
      status: result.status === 'success' ? 'success' : 'failed',
      flow: { id: flow.id, name: flow.name, file: resolveFlowPath(command.file) },
      runId: result.runId,
      stepsExecuted: result.stepCount,
      durationMs: Date.now() - started,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      artifacts: result.artifacts,
      variables: result.variables,
      ...(result.error ? { error: result.error } : {}),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    // Unattended `automate run` invocations (cron, CI) must not fail silently:
    // push the same notice the queue worker sends when a run stops early.
    if (result.status !== 'success' && effectiveConfig.NOTIFY_ON_FAILURE) {
      await deliverRunFailure(notifier, requestedChannels, result, logger, {
        runDir,
        onResult: (results) => {
          for (const entry of results) {
            if (!entry.ok) {
              process.stderr.write(
                `warning: run-failure notification via ${entry.channel} failed: ${entry.error ?? 'unknown'}\n`,
              );
            }
          }
        },
      });
    }
    return result.status === 'success' ? 0 : 1;
  } catch (error) {
    const robo = toRoboError(error);
    process.stdout.write(
      `${JSON.stringify({ command: 'run', status: 'failed', error: { code: robo.code, message: robo.message } }, null, 2)}\n`,
    );
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await service.abortAll('cli run finished').catch(() => undefined);
    await runtime.stop().catch(() => undefined);
  }
}

/* --------------------------------------------------------------------- serve */

async function serveCommand(
  command: Extract<ReturnType<typeof parseArgs>['command'], { kind: 'serve' }>,
): Promise<number> {
  const base = loadConfig(process.env);
  const config = {
    ...base,
    ...(command.host ? { HOST: command.host } : {}),
    ...(command.port ? { PORT: command.port } : {}),
  };
  const logger = createLogger({ level: config.LOG_LEVEL, base: { scope: 'server' } });
  const serve = createServe(config, logger);
  const url = await serve.http.listen();
  logger.info({ url }, 'robrowser server ready');

  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => resolvePromise();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  await serve.close();
  return 0;
}

/* ------------------------------------------------------------------ helpers */

function readVersion(): string {
  return process.env.npm_package_version ?? '0.1.0';
}

function countSteps(flow: FlowModel): number {
  let total = 0;
  const visit = (steps: readonly FlowModel['steps'][number][]): void => {
    for (const step of steps) {
      total += 1;
      if (step.type === 'branch') {
        visit(step.then);
        if (step.else) visit(step.else);
      } else if (step.type === 'loop') {
        visit(step.steps);
      }
    }
  };
  visit(flow.steps);
  return total;
}

/* ------------------------------------------------------------------- entry */

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

void RoboError;

