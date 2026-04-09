/**
 * grouping/types.ts
 *
 * Core interfaces for the trade grouping pipeline.
 *
 * The pipeline is a Chain of Responsibility: an ordered list of GroupingRules,
 * each processing ungrouped fills and passing remainders to the next rule.
 * After grouping, an ordered list of GroupClassifiers determines the trade type.
 *
 * Extensibility: add a new rule by implementing GroupingRule in a new file
 * under rules/ and registering it in rules/index.ts. Same for classifiers.
 */

import type { Trade } from '../../../generated/prisma/client';

// ─── Trade types ─────────────────────────────────────────────────────────────

export const TRADE_TYPES = [
  'scalp',
  'directional',
  'scaled_directional',
  'market_making',
  'delta_neutral',
  'pairs_trade',
  'carry_trade',
] as const;

export type TradeType = (typeof TRADE_TYPES)[number];

// ─── Fill — a database Trade record used as input ────────────────────────────

/** The subset of a Trade record that grouping rules need. */
export type Fill = Pick<
  Trade,
  | 'id'
  | 'walletAddress'
  | 'asset'
  | 'direction'
  | 'size'
  | 'entryPrice'
  | 'exitPrice'
  | 'entryTime'
  | 'exitTime'
  | 'pnlRealized'
  | 'fees'
  | 'fundingEarned'
  | 'fundingPaid'
  | 'holdTimeSeconds'
  | 'rawData'
  | 'builderCode'
  | 'subaccount'
  | 'tradeType'
>;

/** Parsed raw_data fields useful for grouping. */
export interface ParsedRawData {
  order_id?: number;
  client_order_id?: string | null;
  side?: string;
  cause?: string;
  [key: string]: unknown;
}

export function parseRawData(fill: Fill): ParsedRawData {
  if (!fill.rawData) return {};
  try {
    return JSON.parse(fill.rawData) as ParsedRawData;
  } catch {
    return {};
  }
}

// ─── Grouping rule interface ─────────────────────────────────────────────────

export interface GroupingResult {
  /** Groups this rule created from the input fills. */
  newGroups: ProposedGroup[];
  /** Fills this rule couldn't group — passed to the next rule. */
  remainingFills: Fill[];
}

export interface GroupingRule {
  /** Human-readable name (e.g. 'explicit-link'). */
  readonly name: string;
  /** Lower number = runs first. */
  readonly priority: number;
  /** Process ungrouped fills, return groups + leftovers. */
  apply(fills: Fill[], existingGroups: ProposedGroup[]): GroupingResult;
}

// ─── Proposed group ──────────────────────────────────────────────────────────

export interface ProposedGroup {
  fills: Fill[];
  confidence: number;
  ruleSource: string;
  suggestedType?: TradeType;
  /** Computed after classification. */
  classifiedType?: TradeType;
  classifiedConfidence?: number;
}

// ─── Classifier interface ────────────────────────────────────────────────────

export interface ClassificationResult {
  type: TradeType;
  confidence: number;
}

export interface GroupClassifier {
  /** Human-readable name. */
  readonly name: string;
  /** Return a classification or null if this classifier doesn't match. */
  classify(group: ProposedGroup): ClassificationResult | null;
}

// ─── Pipeline output ─────────────────────────────────────────────────────────

export interface GroupingSummary {
  totalFills: number;
  totalGroups: number;
  autoGroupedHighConfidence: number;
  needsReview: number;
  byType: Partial<Record<TradeType, number>>;
  byRule: Record<string, number>;
}
