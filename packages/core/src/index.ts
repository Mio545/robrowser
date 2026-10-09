/**
 * `@robrowser/core` public surface.
 *
 * Pure Node/TypeScript: no electron / react / express / fastify imports anywhere
 * in this package (enforced by ESLint `no-restricted-imports`).
 */

/* -- flow contract --------------------------------------------------------- */
export * from './flow/schema.js';
export {
  validateFlow,
  assertValidFlow,
  collectSteps,
  type ValidationIssue,
  type ValidationResult,
} from './flow/validate.js';
export { parseFlow, loadFlow, saveFlow, stringifyFlow } from './flow/loader.js';
export { resolveNavigationUrl, setFlowBaseDir, flowBaseDir } from './flow/url.js';

/* -- errors ---------------------------------------------------------------- */
export * from './errors.js';

/* -- engine ---------------------------------------------------------------- */
export {
  Orchestrator,
  type OrchestratorDeps,
  type RunResult,
  type RunOptions,
  type StepRunOutcome,
} from './engine/orchestrator.js';
export type {
  PagePort,
  LoggerPort,
  ElementHandleInfo,
  ScreenshotOptions,
  CDPSessionPort,
} from './engine/ports.js';
export { nullLogger } from './engine/ports.js';
export type { StepContext, PageRegistry, RunArtifacts } from './engine/context.js';
export {
  createRunArtifacts,
  artifactPath,
  ARTIFACT_SUBDIRS,
  type ArtifactSubdir,
} from './engine/artifacts.js';
export {
  readCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  comparePaths,
  CHECKPOINT_FILENAME,
  type Checkpoint,
} from './engine/checkpoint.js';
export {
  createConditionEvaluator,
  matchPage,
  matchCondition,
  matchesPattern,
  deepEqual,
  type ConditionEvaluator,
  type MatchResult,
  type MatchDetail,
} from './engine/condition.js';
export { sleep, withTimeout, backoffDelay } from './engine/timing.js';

/* -- events ---------------------------------------------------------------- */
export {
  EventBus,
  summarizeStep,
  type RunEvent,
  type RunEventMap,
  type RunEventName,
  type RunStatus,
  type RunStopReason,
  type Listener,
} from './events/bus.js';

/* -- variables ------------------------------------------------------------- */
export {
  VariableStore,
  interpolate,
  processEnvironment,
  type VarEntry,
  type VarScope,
  type VariableEnvironment,
} from './vars/store.js';
export { buildVariableStore, resolveVariableDef, isSecretDef } from './vars/resolvers.js';

/* -- steps ----------------------------------------------------------------- */
export { StepRegistry, createDefaultRegistry } from './steps/index.js';
export type { RegistryValidation } from './steps/registry.js';
export type { StepHandler, StepResult, StepStatus } from './steps/types.js';
export { defineHandler, requireNestedExecutor, type CompositeStepContext } from './steps/types.js';

/* -- observer -------------------------------------------------------------- */
export {
  DefaultPageObserver,
  type PageObserver,
  type WaitForPageOptions,
} from './observer/observer.js';
export {
  NetworkWatcher,
  type NetworkRecord,
  type NetworkWatcherOptions,
  type CDPSessionLike,
} from './observer/network.js';
export { pageRuleSchema, matchConditionSchema } from './observer/pageRule.js';
export { DEFAULT_PAGE_RULES, createPageRegistry } from './flow/pageRegistry.js';

/* -- handlers -------------------------------------------------------------- */
export {
  UnsupportedManualHandler,
  AutoResolveManualHandler,
  type ManualHandler,
  type ManualRequest,
  type ManualResult,
  type ManualReason,
} from './handlers/manual.js';

/* -- exporters ------------------------------------------------------------- */
export {
  exportFlow,
  exportPlaywright,
  exportRawCdp,
  type ExportTarget,
  type ExportOptions,
  type RawCdpOptions,
  type ExportByTargetOptions,
} from './exporters/index.js';

/* -- storage --------------------------------------------------------------- */
export {
  InMemoryFlowRepository,
  type FlowRepository,
  type RunRecord,
  type StoredFlow,
  type RunQuery,
} from './storage/repo.js';
