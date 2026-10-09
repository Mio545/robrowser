/**
 * `waitForDownload` step: block until a download starts, then save it.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { resolveTimeout } from './helpers.js';
import { artifactPath } from '../engine/artifacts.js';

type WaitForDownloadStep = Extract<Step, { type: 'waitForDownload' }>;

/** Handler for `waitForDownload`. */
export const waitForDownloadHandler = defineHandler<WaitForDownloadStep>({
  type: 'waitForDownload',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const timeout = resolveTimeout(config.timeout, 60_000);
    ctx.log('info', 'waiting for download', { timeout });
    const download = await ctx.page.waitForDownload({ timeout });
    const relative = config.saveTo
      ? ctx.vars.interpolate(config.saveTo)
      : `downloads/${download.suggestedFilename}`;
    const target =
      relative.includes('/') || relative.includes('\\')
        ? relative
        : artifactPath(ctx.artifacts.runDir, 'downloads', relative);
    await download.saveAs(target);
    ctx.artifacts.add(target);
    ctx.log('info', 'download saved', { path: target });
    return { status: 'ok', output: { path: target, filename: download.suggestedFilename } };
  },
});
