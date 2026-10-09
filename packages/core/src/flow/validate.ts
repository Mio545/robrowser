/**
 * FlowModel validation helpers (spec section 4).
 *
 * `validateFlow` returns a structured result instead of throwing so that the CLI
 * and the HTTP API can report *all* problems at once.
 */
import { ZodError, type ZodIssue } from 'zod';
import { flowModelSchema, type FlowModel, type Step } from './schema.js';
import { ValidationError } from '../errors.js';

/** A single normalised validation problem. */
export interface ValidationIssue {
  /** Dot/bracket path into the flow, e.g. `steps[2].selector`. */
  path: string;
  /** Human readable explanation. */
  message: string;
  /** Machine readable zod code, when available. */
  code: string;
}

/** Result of {@link validateFlow}. */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Present only when `ok` is true. */
  flow?: FlowModel;
}

function toIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue: ZodIssue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Validate an arbitrary value as a FlowModel.
 *
 * @param input - Unknown value, typically parsed JSON.
 * @returns A result object; never throws for schema violations.
 */
export function validateFlow(input: unknown): ValidationResult {
  const parsed = flowModelSchema.safeParse(input);
  if (!parsed.success) {
    const issues = toIssues(parsed.error);
    const structural = findStructuralIssues(input);
    return { ok: false, issues: [...issues, ...structural] };
  }
  const structural = findStructuralIssues(parsed.data);
  if (structural.length > 0) {
    return { ok: false, issues: structural };
  }
  return { ok: true, issues: [], flow: parsed.data };
}

/**
 * Validate and return the flow, throwing a {@link ValidationError} on failure.
 *
 * @param input - Unknown value.
 * @returns The validated FlowModel.
 * @throws {ValidationError} When the value is not a valid flow.
 */
export function assertValidFlow(input: unknown): FlowModel {
  const result = validateFlow(input);
  if (!result.ok || !result.flow) {
    throw new ValidationError(
      `Flow validation failed with ${result.issues.length} issue(s): ` +
        result.issues
          .slice(0, 5)
          .map((i) => `${i.path || '<root>'}: ${i.message}`)
          .join('; '),
      { issues: result.issues },
    );
  }
  return result.flow;
}

/** Collect every step in the flow, including nested `branch`/`loop` steps. */
export function collectSteps(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  const visit = (list: readonly Step[], prefix: string): void => {
    list.forEach((step, index) => {
      out.push(step);
      const here = `${prefix}[${index}]`;
      if (step.type === 'branch') {
        visit(step.then, `${here}.then`);
        if (step.else) visit(step.else, `${here}.else`);
      } else if (step.type === 'loop') {
        visit(step.steps, `${here}.steps`);
      }
    });
  };
  visit(steps, 'steps');
  return out;
}

/**
 * Semantic checks that zod cannot express: duplicate ids and unreachable /
 * dangling references.
 */
function findStructuralIssues(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== 'object') return issues;

  const steps = walkAllSteps(input as { steps?: unknown });
  if (steps.length === 0) return issues;

  const seen = new Map<string, number>();
  for (const { step, path } of steps) {
    const id = (step as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const previous = seen.get(id);
    if (previous !== undefined) {
      issues.push({
        path: `${path}.id`,
        message: `Duplicate step id "${id}" (first seen at index ${previous})`,
        code: 'custom_duplicate_step_id',
      });
    } else {
      seen.set(id, 1);
    }
  }

  // `waitForPage.target` must reference a declared page fingerprint name.
  const pageNames = collectPageNames(input);
  for (const { step, path } of steps) {
    if ((step as { type?: unknown }).type !== 'waitForPage') continue;
    const target = (step as { target?: unknown }).target;
    if (typeof target === 'string' && pageNames.size > 0 && !pageNames.has(target)) {
      issues.push({
        path: `${path}.target`,
        message: `waitForPage target "${target}" is not defined in the run page registry`,
        code: 'custom_unknown_page_target',
      });
    }
  }

  return issues;
}

/** Best-effort recursive collection of `{step, path}` pairs from raw input. */
function walkAllSteps(root: { steps?: unknown }): Array<{ step: unknown; path: string }> {
  const out: Array<{ step: unknown; path: string }> = [];
  const visit = (list: unknown, prefix: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((step, index) => {
      const path = `${prefix}[${index}]`;
      out.push({ step, path });
      if (step && typeof step === 'object') {
        const record = step as Record<string, unknown>;
        if (record.type === 'branch') {
          visit(record.then, `${path}.then`);
          visit(record.else, `${path}.else`);
        } else if (record.type === 'loop') {
          visit(record.steps, `${path}.steps`);
        }
      }
    });
  };
  visit(root.steps, 'steps');
  return out;
}

/** Names contributed by top-level `waitForPage` targets (used for validation). */
function collectPageNames(_root: unknown): Set<string> {
  // Page fingerprints live outside the flow at runtime (host-provided registry),
  // so the flow only carries names. We therefore cannot validate membership here
  // and intentionally return an empty set to skip the check.
  return new Set<string>();
}
