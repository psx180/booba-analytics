/**
 * grouping/index.ts
 *
 * Public API for the grouping pipeline.
 */

export { GroupingService } from './grouping-service';
export { createDefaultRules } from './rules';
export { createDefaultClassifiers } from './classifiers';
export type {
  Fill,
  GroupingRule,
  GroupClassifier,
  ProposedGroup,
  GroupingSummary,
  TradeType,
  TRADE_TYPES,
} from './types';
