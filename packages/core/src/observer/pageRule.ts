/**
 * Page fingerprint schema + matching (spec 5.3).
 *
 * The zod schema itself lives in `flow/schema.ts` (it is part of the FlowModel
 * contract); this module re-exports it and provides the pure matching helpers.
 */
export {
  pageRuleSchema,
  matchConditionSchema,
  type PageRule,
  type MatchCondition,
} from '../flow/schema.js';

export {
  matchPage,
  matchCondition,
  matchesPattern,
  type MatchDetail,
  type MatchResult,
  type PageFingerprint,
} from '../engine/condition.js';
