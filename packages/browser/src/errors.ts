/**
 * Browser-package error helpers.
 *
 * Re-exported (and reused) from `@robrowser/core` so that every host sees the
 * same error taxonomy and `code` values.
 */
export {
  RoboError,
  CdpError,
  ValidationError,
  SelectorNotFoundError,
  StepError,
  StepTimeoutError,
  RunAbortedError,
  TakeoverError,
  RoboError as BrowserError,
  toRoboError,
  isRoboError,
  describeSelector,
  type ErrorCode,
} from '@robrowser/core';
