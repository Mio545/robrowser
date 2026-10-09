#!/usr/bin/env node
/**
 * RoboBrowser CLI (spec 7.1).
 *
 *   automate run      <flow.json> [--headless|--headful] [--chrome <path>] [--out <dir>] [--var k=v]
 *   automate validate <flow.json>
 *   automate export   <flow.json> --target playwright|raw-cdp [--out file]
 *   automate serve    [--host <host>] [--port <port>]
 *   automate takeover <flow.json> [--headless] [--out <dir>] [--var k=v]
 *
 * Exit codes: 0 on success, non-zero on failure. Every run prints a structured
 * JSON summary on stdout so CI can consume it; diagnostics go to stderr via pino
 * (except for the summary, which is explicitly machine-readable stdout output).
 */
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFlow, exportFlow, RoboError, toRoboError, type FlowModel } from '@robrowser/core';
import { parseArgs, USAGE } from './cli-args.js';
import { resolveFlowPath } from './cli-paths.js';
import { loadConfig } from './env.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';
import { TicketService } from './takeover/tokens.js';
import { TakeoverService, RemoteTakeoverHandler } from './takeover/service.js';
import { Notifier } from './notify/notifier.js';
import { LogNotificationChannel } from './notify/channels/log.js';
import { WebhookNotificationChannel } from './notify/channels/webhook.js';
import { EmailNotificationChannel } from './notify/channels/email.js';
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
    case 'run':
      return runCommand(command);
    case 'serve':
      return serveCommand(command);
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
    const flow = await loadFlow(resolveFlowPath(file));
    process.stdout.write(
      `${JSON.stringify(
        {
          command: 'validate',
          status: 'ok',
          file: resolve(file),
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
  const notifier = new Notifier(logger);
  notifier.register(new LogNotificationChannel(logger));
  if (effectiveConfig.WEBHOOK_URL) {
    notifier.register(new WebhookNotificationChannel({ url: effectiveConfig.WEBHOOK_URL }));
  }
  if (effectiveConfig.SMTP_URL && effectiveConfig.NOTIFY_TO) {
    notifier.register(
      new EmailNotificationChannel({
        transport: effectiveConfig.SMTP_URL,
        to: effectiveConfig.NOTIFY_TO,
        subjectPrefix: '[RoboBrowser]',
      }),
    );
  }

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

  const runtime = createRuntime({
    logger,
    config: effectiveConfig,
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
