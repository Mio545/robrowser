/**
 * Built-in step handlers and the factory that assembles the default registry.
 *
 * Registering a handler is the *only* place a new step type needs to be known;
 * the orchestrator is type agnostic (spec 5.2).
 */
import { StepRegistry } from './registry.js';
import { gotoHandler } from './goto.js';
import { clickHandler } from './click.js';
import { typeHandler } from './type.js';
import { selectHandler } from './select.js';
import { hoverHandler } from './hover.js';
import { scrollHandler } from './scroll.js';
import { waitForPageHandler } from './waitForPage.js';
import { waitForSelectorHandler } from './waitForSelector.js';
import { waitForUrlHandler } from './waitForUrl.js';
import { waitForNetworkIdleHandler } from './waitForNetworkIdle.js';
import { waitForDownloadHandler } from './waitForDownload.js';
import { extractHandler } from './extract.js';
import { screenshotHandler } from './screenshot.js';
import { branchHandler } from './branch.js';
import { loopHandler } from './loop.js';
import { setVarHandler } from './setVar.js';
import { httpCallHandler } from './httpCall.js';
import { manualHandler } from './manual.js';

export { StepRegistry } from './registry.js';
export type { StepHandler, StepResult, StepStatus } from './types.js';

/**
 * Create a registry pre-populated with every built-in handler.
 *
 * @returns A fresh {@link StepRegistry}.
 */
export function createDefaultRegistry(): StepRegistry {
  return new StepRegistry()
    .register(gotoHandler)
    .register(clickHandler)
    .register(typeHandler)
    .register(selectHandler)
    .register(hoverHandler)
    .register(scrollHandler)
    .register(waitForPageHandler)
    .register(waitForSelectorHandler)
    .register(waitForUrlHandler)
    .register(waitForNetworkIdleHandler)
    .register(waitForDownloadHandler)
    .register(extractHandler)
    .register(screenshotHandler)
    .register(branchHandler)
    .register(loopHandler)
    .register(setVarHandler)
    .register(httpCallHandler)
    .register(manualHandler);
}

export {
  gotoHandler,
  clickHandler,
  typeHandler,
  selectHandler,
  hoverHandler,
  scrollHandler,
  waitForPageHandler,
  waitForSelectorHandler,
  waitForUrlHandler,
  waitForNetworkIdleHandler,
  waitForDownloadHandler,
  extractHandler,
  screenshotHandler,
  branchHandler,
  loopHandler,
  setVarHandler,
  httpCallHandler,
  manualHandler,
};
