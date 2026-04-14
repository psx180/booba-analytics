/**
 * Shared Playbook types. Lives apart from `rule-checkers.ts` so UI, API
 * routes, and the adherence service can all import without pulling the
 * Prisma client transitively.
 */

import type { Candle } from '../regime/types';

/**
 * One rule inside a playbook. `type` picks the checker function;
 * `params` is checker-specific. `label` is what the user sees in the
 * adherence breakdown when the rule passes or fails.
 */
export interface PlaybookRule {
  type: string;
  params: Record<string, unknown>;
  enabled: boolean;
  label: string;
}

/**
 * A rule is either passed, failed, or inconclusive — the third case covers
 * rules that need data the position doesn't have (e.g. EMA when candles
 * aren't in cache, position size when equity is unknown). Inconclusive
 * rules are excluded from the score denominator but still rendered in the
 * breakdown so the user sees what couldn't be checked.
 */
export type RuleOutcome = 'passed' | 'failed' | 'inconclusive';

export interface RuleResult {
  ruleType: string;
  ruleLabel: string;
  outcome: RuleOutcome;
  actual: string;
  expected: string;
}

/**
 * Context passed to checkers that need more than the position row —
 * candles for entry_near_ema, account equity for position_size, a
 * precomputed daily trade count for max_daily_trades.
 *
 * All optional: checkers degrade to inconclusive when the data they need
 * is absent rather than throwing.
 */
export interface RuleCheckContext {
  candles?: Candle[];
  accountEquity?: number;
  dailyTradeCount?: number;
}

export interface AdherenceResult {
  score: number;        // 0-100, passed / (passed + failed) * 100
  passed: number;
  failed: number;
  inconclusive: number;
  results: RuleResult[];
}
