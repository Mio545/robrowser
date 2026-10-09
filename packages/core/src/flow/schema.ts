/**
 * FlowModel contract (section 4 of the specification).
 *
 * The zod schemas here are the single source of truth for *runtime validation*,
 * while the exported TypeScript types below are declared explicitly so that the
 * recursive `Step` union can be referenced by the schemas themselves (a schema
 * typed as `z.ZodType<Step>` cannot infer `Step` from itself).
 *
 * NOTE on `z.unknown()`: in zod 3 it marks the key as optional. Where the
 * specification requires the key to be *present* while accepting any value
 * (`const` variable values, `setVar.value`, `varEquals.value`) we use
 * {@link requiredUnknown}, which keeps the key required and types as `unknown`.
 */
import { z } from 'zod';

/** `z.unknown()` that keeps the key required in the inferred type. */
// z.custom keeps the key required: in zod 3 `z.unknown()` marks object keys
// optional, which would silently accept a missing `setVar.value`.
const requiredUnknown = (): z.ZodType<unknown> =>
  z.custom<unknown>((value) => value !== undefined, { message: 'Required' });

/* --------------------------------------------------------------- Selector */

/** Selector strategy: several attempts are made in order. `candidates` nests. */
export type SelectorSpec =
  | string
  | { testId: string }
  | { role: string; name?: string }
  | { text: string; exact?: boolean }
  | { css: string }
  | { xpath: string }
  | { candidates: SelectorSpec[] };

/** Schema mirroring {@link SelectorSpec}. */
export const selectorSpecSchema: z.ZodType<SelectorSpec> = z.lazy(
  () =>
    z.union([
      z.string().min(1),
      z.object({ testId: z.string().min(1) }).strict(),
      z.object({ role: z.string().min(1), name: z.string().optional() }).strict(),
      z.object({ text: z.string().min(1), exact: z.boolean().optional() }).strict(),
      z.object({ css: z.string().min(1) }).strict(),
      z.object({ xpath: z.string().min(1) }).strict(),
      z.object({ candidates: z.array(selectorSpecSchema).min(1) }).strict(),
    ]) as unknown as z.ZodType<SelectorSpec>,
);

/* -------------------------------------------------------------- Condition */

/** A single condition used by `branch` steps. */
export type Condition =
  | { pageIs: string }
  | { varEquals: { name: string; value: unknown } }
  | { selectorExists: SelectorSpec }
  | { not: Condition }
  | { all: Condition[] }
  | { any: Condition[] };

/** Schema mirroring {@link Condition}. */
export const conditionSchema: z.ZodType<Condition> = z.lazy(
  () =>
    z.union([
      z.object({ pageIs: z.string().min(1) }).strict(),
      z
        .object({
          varEquals: z.object({ name: z.string().min(1), value: requiredUnknown() }).strict(),
        })
        .strict(),
      z.object({ selectorExists: selectorSpecSchema }).strict(),
      z.object({ not: conditionSchema }).strict(),
      z.object({ all: z.array(conditionSchema) }).strict(),
      z.object({ any: z.array(conditionSchema) }).strict(),
    ]) as unknown as z.ZodType<Condition>,
);

/* ------------------------------------------------------------- Page rules */

/** A single DOM match predicate used inside a {@link PageRule}. */
export interface MatchCondition {
  selector?: string;
  state?: 'attached' | 'visible' | 'hidden';
  text?: string;
  count?: { eq?: number; gte?: number };
}

export const matchConditionSchema: z.ZodType<MatchCondition> = z
  .object({
    selector: z.string().min(1).optional(),
    state: z.enum(['attached', 'visible', 'hidden']).optional(),
    text: z.string().optional(),
    count: z
      .object({
        eq: z.number().int().nonnegative().optional(),
        gte: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Page fingerprint rule used by `waitForPage` and `manual.resolveWhen`. */
export interface PageRule {
  name?: string;
  match: {
    url?: string;
    title?: string;
    any?: MatchCondition[];
    all?: MatchCondition[];
  };
}

export const pageRuleSchema: z.ZodType<PageRule> = z
  .object({
    name: z.string().optional(),
    match: z
      .object({
        url: z.string().optional(),
        title: z.string().optional(),
        any: z.array(matchConditionSchema).optional(),
        all: z.array(matchConditionSchema).optional(),
      })
      .strict(),
  })
  .strict();

/* ------------------------------------------------------------- Variables */

/** Variable declaration. */
export type VariableDef =
  | { type: 'const'; value: unknown }
  | { type: 'env'; key: string; default?: string }
  | { type: 'secret'; key: string; default?: string }
  | { type: 'input'; label: string; default?: string };

export const variableDefSchema: z.ZodType<VariableDef> = z.union([
  z.object({ type: z.literal('const'), value: requiredUnknown() }).strict(),
  z
    .object({ type: z.literal('env'), key: z.string().min(1), default: z.string().optional() })
    .strict(),
  z
    .object({ type: z.literal('secret'), key: z.string().min(1), default: z.string().optional() })
    .strict(),
  z
    .object({ type: z.literal('input'), label: z.string().min(1), default: z.string().optional() })
    .strict(),
]) as unknown as z.ZodType<VariableDef>;

/* ------------------------------------------------------------------ Steps */

/** Shared `timeout` field shape (positive integer, milliseconds). */
const timeoutField = z.number().int().positive().optional();

/** `goto` step. */
export interface GotoStep {
  id: string;
  type: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}
/** `click` step. */
export interface ClickStep {
  id: string;
  type: 'click';
  selector: SelectorSpec;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}
/** `type` step. */
export interface TypeStep {
  id: string;
  type: 'type';
  selector: SelectorSpec;
  value: string;
  clear?: boolean;
  delayMs?: number;
  submit?: boolean;
}
/** `select` step. */
export interface SelectStep {
  id: string;
  type: 'select';
  selector: SelectorSpec;
  value: string;
}
/** `hover` step. */
export interface HoverStep {
  id: string;
  type: 'hover';
  selector: SelectorSpec;
}
/** `scroll` step. */
export interface ScrollStep {
  id: string;
  type: 'scroll';
  x?: number;
  y?: number;
  selector?: SelectorSpec;
}
/** `waitForPage` step. */
export interface WaitForPageStep {
  id: string;
  type: 'waitForPage';
  target: string;
  timeout?: number;
}
/** `waitForSelector` step. */
export interface WaitForSelectorStep {
  id: string;
  type: 'waitForSelector';
  selector: SelectorSpec;
  state?: 'attached' | 'visible' | 'hidden';
  timeout?: number;
}
/** `waitForUrl` step. */
export interface WaitForUrlStep {
  id: string;
  type: 'waitForUrl';
  pattern: string;
  timeout?: number;
}
/** `waitForNetworkIdle` step. */
export interface WaitForNetworkIdleStep {
  id: string;
  type: 'waitForNetworkIdle';
  idleMs?: number;
  timeout?: number;
}
/** `waitForDownload` step. */
export interface WaitForDownloadStep {
  id: string;
  type: 'waitForDownload';
  timeout?: number;
  saveTo?: string;
}
/** `extract` step. */
export interface ExtractStep {
  id: string;
  type: 'extract';
  selector: SelectorSpec;
  attr?: string;
  into: string;
  all?: boolean;
}
/** `screenshot` step. */
export interface ScreenshotStep {
  id: string;
  type: 'screenshot';
  saveTo?: string;
  fullPage?: boolean;
}
/** `branch` step. */
export interface BranchStep {
  id: string;
  type: 'branch';
  condition: Condition;
  then: Step[];
  else?: Step[];
}
/** `loop` step. */
export interface LoopStep {
  id: string;
  type: 'loop';
  items: string | unknown[];
  as: string;
  steps: Step[];
  maxIterations?: number;
}
/** `setVar` step. */
export interface SetVarStep {
  id: string;
  type: 'setVar';
  name: string;
  value: unknown;
}
/** `httpCall` step. */
export interface HttpCallStep {
  id: string;
  type: 'httpCall';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  into?: string;
}
/** `manual` step. */
export interface ManualStep {
  id: string;
  type: 'manual';
  reason: 'captcha' | 'sms' | 'otp' | 'confirm' | 'other';
  message: string;
  resolveWhen?: PageRule;
  timeoutMs?: number;
  notify?: string[];
}

/** Discriminated union of every step type. */
export type Step =
  | GotoStep
  | ClickStep
  | TypeStep
  | SelectStep
  | HoverStep
  | ScrollStep
  | WaitForPageStep
  | WaitForSelectorStep
  | WaitForUrlStep
  | WaitForNetworkIdleStep
  | WaitForDownloadStep
  | ExtractStep
  | ScreenshotStep
  | BranchStep
  | LoopStep
  | SetVarStep
  | HttpCallStep
  | ManualStep;

/** The `type` tag of a step. */
export type StepType = Step['type'];

/** Base fields shared by every step schema. */
const stepBase = { id: z.string().min(1) };

/**
 * Schema mirroring {@link Step}. `z.lazy` is required because `branch` and
 * `loop` contain nested `Step[]`.
 */
export const stepSchema: z.ZodType<Step> = z.lazy(
  () =>
    z.discriminatedUnion('type', [
      z
        .object({
          ...stepBase,
          type: z.literal('goto'),
          url: z.string().min(1),
          waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('click'),
          selector: selectorSpecSchema,
          button: z.enum(['left', 'right', 'middle']).optional(),
          clickCount: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('type'),
          selector: selectorSpecSchema,
          value: z.string(),
          clear: z.boolean().optional(),
          delayMs: z.number().int().nonnegative().optional(),
          submit: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('select'),
          selector: selectorSpecSchema,
          value: z.string(),
        })
        .strict(),
      z.object({ ...stepBase, type: z.literal('hover'), selector: selectorSpecSchema }).strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('scroll'),
          x: z.number().optional(),
          y: z.number().optional(),
          selector: selectorSpecSchema.optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('waitForPage'),
          target: z.string().min(1),
          timeout: timeoutField,
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('waitForSelector'),
          selector: selectorSpecSchema,
          state: z.enum(['attached', 'visible', 'hidden']).optional(),
          timeout: timeoutField,
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('waitForUrl'),
          pattern: z.string().min(1),
          timeout: timeoutField,
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('waitForNetworkIdle'),
          idleMs: z.number().int().nonnegative().optional(),
          timeout: timeoutField,
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('waitForDownload'),
          timeout: timeoutField,
          saveTo: z.string().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('extract'),
          selector: selectorSpecSchema,
          attr: z.string().optional(),
          into: z.string().min(1),
          all: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('screenshot'),
          saveTo: z.string().optional(),
          fullPage: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('branch'),
          condition: conditionSchema,
          then: z.array(stepSchema),
          else: z.array(stepSchema).optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('loop'),
          items: z.union([z.string().min(1), z.array(z.unknown())]),
          as: z.string().min(1),
          steps: z.array(stepSchema),
          maxIterations: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('setVar'),
          name: z.string().min(1),
          value: requiredUnknown(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('httpCall'),
          method: z.string().min(1),
          url: z.string().min(1),
          headers: z.record(z.string()).optional(),
          body: z.unknown().optional(),
          into: z.string().optional(),
        })
        .strict(),
      z
        .object({
          ...stepBase,
          type: z.literal('manual'),
          reason: z.enum(['captcha', 'sms', 'otp', 'confirm', 'other']),
          message: z.string(),
          resolveWhen: pageRuleSchema.optional(),
          timeoutMs: z.number().int().positive().optional(),
          notify: z.array(z.string()).optional(),
        })
        .strict(),
    ]) as unknown as z.ZodType<Step>,
);

/* -------------------------------------------------------------- FlowModel */

/** Error handling policy at flow level. */
export interface OnErrorPolicy {
  retry?: number;
  backoff?: 'none' | 'linear' | 'exponential';
  screenshot?: boolean;
}

export const onErrorSchema: z.ZodType<OnErrorPolicy> = z
  .object({
    retry: z.number().int().nonnegative().optional(),
    backoff: z.enum(['none', 'linear', 'exponential']).optional(),
    screenshot: z.boolean().optional(),
  })
  .strict();

/** The complete flow definition: the single intermediate representation. */
export interface FlowModel {
  version: '1.0';
  id: string;
  name: string;
  variables?: Record<string, VariableDef>;
  steps: Step[];
  onError?: OnErrorPolicy;
}

export const flowModelSchema: z.ZodType<FlowModel> = z
  .object({
    version: z.literal('1.0'),
    id: z.string().min(1),
    name: z.string().min(1),
    variables: z.record(variableDefSchema).optional(),
    steps: z.array(stepSchema).min(1),
    onError: onErrorSchema.optional(),
  })
  .strict() as unknown as z.ZodType<FlowModel>;
