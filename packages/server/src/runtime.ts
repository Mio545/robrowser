/**
 * Runtime: assembles `core` + `browser` into a runnable unit (spec 3).
 *
 * Both the CLI and the HTTP worker use this module, which is what guarantees a
 * flow behaves identically in the desktop app and on a headless server.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import {
  AutoResolveManualHandler,
  createPageRegistry as createDefaultPageRegistry,
  DefaultPageObserver,
  EventBus,
  Orchestrator,
  UnsupportedManualHandler,
  VariableStore,
  type FlowModel,
  type ManualHandler,
  type PageObserver,
  type PagePort,
  type PageRegistry,
  type RunResult,
} from '@robrowser/core';
import { RemoteBrowserAdapter, type LaunchOptions } from '@robrowser/browser';
import { chromeArgs, type ServerConfig } from './env.js';
import { toLoggerPort } from './logger.js';

/** Options for {@link createRuntime}. */
export interface RuntimeOptions {
  /** Logger used by every layer. */
  logger: Logger;
  /** Validated server configuration. */
  config: ServerConfig;
  /** Manual interaction handler (remote takeover in the server). */
  manual?: ManualHandler;
  /** Page observer override (tests). */
  observer?: PageObserver;
  /** Named page fingerprints available to `waitForPage` / `pageIs`. */
  pages?: PageRegistry;
  /** Use a fake page instead of launching Chromium (tests). */
  page?: PagePort;
}

/** A ready-to-use runtime handle. */
export interface Runtime {
  /** Launch (or connect to) the browser. Idempotent. */
  start(): Promise<void>;
  /** Close the browser and release resources. */
  stop(): Promise<void>;
  /** The active page. */
  page(): PagePort;
  /** Execute a flow to completion. */
  run(flow: FlowModel, options: RunFlowOptions): Promise<RunResult>;
  /** Event bus for the *current* run (replaced on each `run`). */
  bus(): EventBus;
  /** Browser adapter (undefined when running against an injected fake page). */
  adapter(): RemoteBrowserAdapter | undefined;
}

/** Options for {@link Runtime.run}. */
export interface RunFlowOptions {
  /** Run identifier (used for the run directory and event stream). */
  runId?: string;
  /** `--var` overrides / input values. */
  vars?: Record<string, unknown>;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Directory for artefacts; defaults to `<RUN_DIR>/runs/<runId>`. */
  runDir?: string;
}

/**
 * Create the runtime. `start()` must be called before `run()`.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { logger, config } = options;
  const loggerPort = toLoggerPort(logger);
  const observer = options.observer ?? new DefaultPageObserver(loggerPort);
  const pages = options.pages ?? createDefaultPageRegistry();

  let adapter: RemoteBrowserAdapter | undefined;
  let page: PagePort | undefined = options.page;
  let context: Awaited<ReturnType<RemoteBrowserAdapter['newContext']>> | undefined;
  let bus = new EventBus();

  const ensurePage = async (): Promise<PagePort> => {
    if (page) return page;
    if (!adapter) {
      adapter = new RemoteBrowserAdapter();
      const launchOptions: LaunchOptions = {
        headless: config.HEADLESS,
        args: chromeArgs(config),
        ...(config.CHROME_PATH ? { executablePath: config.CHROME_PATH } : {}),
      };
      logger.info({ headless: config.HEADLESS, args: launchOptions.args }, 'launching chromium');
      await adapter.launch(launchOptions);
      context = await adapter.newContext();
    }
    if (!page) {
      page = await context!.newPage();
      logger.debug({ url: await page.url() }, 'page ready');
    }
    return page;
  };

  const manual =
    options.manual ??
    (process.env.ROBO_AUTO_MANUAL === '1'
      ? new AutoResolveManualHandler('cli')
      : new UnsupportedManualHandler());

  return {
    async start(): Promise<void> {
      await ensurePage();
    },

    async stop(): Promise<void> {
      if (adapter) {
        await adapter.close();
        adapter = undefined;
        context = undefined;
      }
      if (!options.page) page = undefined;
    },

    page(): PagePort {
      if (!page) throw new Error('Runtime has not been started; call start() first');
      return page;
    },

    bus(): EventBus {
      return bus;
    },

    adapter(): RemoteBrowserAdapter | undefined {
      return adapter;
    },

    async run(flow: FlowModel, runOptions: RunFlowOptions): Promise<RunResult> {
      const activePage = await ensurePage();
      bus = new EventBus();
      const runId = runOptions.runId ?? `${flow.id}-${Date.now().toString(36)}`;
      const runDir = resolve(runOptions.runDir ?? join(config.RUN_DIR, 'runs', runId));
      await mkdir(runDir, { recursive: true });

      const variableStore = new VariableStore();
      await variableStore.declare(flow.variables, runOptions.vars ?? {});

      const orchestrator = new Orchestrator({
        page: activePage,
        bus,
        variableStore,
        runDir,
        manual,
        observer,
        pages,
        logger: loggerPort,
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });

      logger.info({ flowId: flow.id, runId, runDir }, 'running flow');
      return orchestrator.run(flow);
    },
  };
}

/**
 * Build a {@link PageRegistry} from a plain name -> PageRule map.
 *
 * @param rules - Named fingerprint rules.
 */
export function createPageRegistry(
  rules: Record<string, import('@robrowser/core').PageRule>,
): PageRegistry {
  return {
    get: (name) => rules[name] ?? null,
    names: () => Object.keys(rules),
  };
}
