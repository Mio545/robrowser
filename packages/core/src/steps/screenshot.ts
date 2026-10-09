/**
 * `screenshot` step: capture the page (optionally full page) into the run dir.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { artifactPath } from '../engine/artifacts.js';

type ScreenshotStep = Extract<Step, { type: 'screenshot' }>;

/** Handler for `screenshot`. */
export const screenshotHandler = defineHandler<ScreenshotStep>({
  type: 'screenshot',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const fullPage = config.fullPage ?? false;
    const buffer = await ctx.page.screenshot({ format: 'png', fullPage });
    const requested = config.saveTo ? ctx.vars.interpolate(config.saveTo) : `${config.id}.png`;
    const target =
      requested.includes('/') || requested.includes('\\')
        ? requested
        : artifactPath(ctx.artifacts.runDir, 'screenshots', requested);
    const saved = await ctx.artifacts.save(target, buffer);
    ctx.emitScreenshot({ path: saved, base64: buffer.toString('base64') });
    ctx.log('info', `screenshot saved`, { path: saved, fullPage });
    return { status: 'ok', output: { path: saved } };
  },
});
