/**
 * `httpCall` step: perform an HTTP request from the *host* (not the page) and
 * optionally store the parsed JSON response in a variable.
 *
 * Uses the global `fetch` available in Node 20+; no extra dependency.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { RoboError } from '../errors.js';

type HttpCallStep = Extract<Step, { type: 'httpCall' }>;

/** Handler for `httpCall`. */
export const httpCallHandler = defineHandler<HttpCallStep>({
  type: 'httpCall',
  validate(config) {
    const problems: string[] = [];
    if (config.url.trim().length === 0) problems.push('url must not be empty');
    if (config.method.trim().length === 0) problems.push('method must not be empty');
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const url = ctx.vars.interpolate(config.url);
    const method = ctx.vars.interpolate(config.method).toUpperCase();
    const headers = config.headers ? ctx.vars.interpolate(config.headers) : undefined;
    const body = config.body === undefined ? undefined : ctx.vars.interpolate(config.body);

    ctx.log('info', `HTTP ${method} ${url}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (error) {
      throw new RoboError(
        'NETWORK_ERROR',
        `HTTP ${method} ${url} failed: ${(error as Error).message}`,
        { url, method, stepId: config.id },
        { cause: error },
      );
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    let parsed: unknown = text;
    if (contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new RoboError('NETWORK_ERROR', `HTTP ${method} ${url} returned ${response.status}`, {
        url,
        method,
        status: response.status,
        body: text.slice(0, 500),
      });
    }

    if (config.into) {
      ctx.vars.set(config.into, parsed, 'runtime');
      ctx.bus.emit('var:set', {
        runId: ctx.runId,
        name: config.into,
        value: parsed,
        scope: 'runtime',
        timestamp: Date.now(),
      });
    }
    return { status: 'ok', output: { status: response.status, body: parsed } };
  },
});
