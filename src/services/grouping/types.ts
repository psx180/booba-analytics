/**
 * grouping/types.ts
 *
 * Core interfaces for the hierarchical grouping pipeline.
 *
 * Trading has a natural hierarchy:
 *   Level 1: Fills → OrderGroups   ("How was this executed?")
 *   Level 2: OrderGroups → Positions  ("What was the directional bet?")
 *   Level 3: Positions → LinkedStrategies  ("What combined trade?")
 *
 * Each level implements GroupingLevel<TInput, TOutput>.
 */

import type { Trade } from '../../../generated/prisma/client';

// ─── Grouping level interface ───────────────────────────────────────────────

export interface GroupingLevel<TInput, TOutput> {
  readonly name: string;
  group(items: TInput[]): TOutput[];
}

// ─── Fill — a database Trade record used as input ───────────────────────────

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
  | 'cause'
  | 'tradeType'
  | 'regimeAtEntry'
  | 'sentimentAtEntry'
>;

export interface ParsedRawData {
  order_id?: number;
  client_order_id?: string | null;
  stop_parent_order_id?: number | null;
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

// ─── TradeUnit — shared interface for anything in the primary view ──────────

export interface TradeUnit {
  id: string;
  pnl: number;
  fees: number;
  funding: number;
  status: 'open' | 'closed';
  firstEntryTime: Date | null;
  lastExitTime: Date | null;
  tradeType: string | null;
  confidence: number;
  regimeAtEntry: string | null;
  sentimentAtEntry: string | null;
}

// ─── Order Group (Level 1 output) ──────────────────────────────────────────

export interface OrderGroupData extends TradeUnit {
  asset: string;
  direction: 'long' | 'short';
  fills: Fill[];
  averageEntryPrice: number;
  averageExitPrice: number | null;
  totalSize: number;
  ruleSource: string;
}

// ─── Position (Level 2 output) ─────────────────────────────────────────────

export interface PositionData extends TradeUnit {
  asset: string;
  direction: 'long' | 'short';
  orders: OrderGroupData[];
  averageEntryPrice: number;
  averageExitPrice: number | null;
  totalSize: number;
  holdTimeSeconds: number | null;
  linkedStrategyId: string | null;
  /** Denormalized from the position's first builder-coded fill (null = manual). */
  builderCode: string | null;
}

// ─── Linked Strategy (Level 3 output) ──────────────────────────────────────

export type StrategyType = 'delta_neutral' | 'pairs_trade' | 'basis_trade';

export interface LinkedStrategyData extends TradeUnit {
  strategyType: StrategyType;
  legs: PositionData[];
  combinedPnl: number;
  combinedFees: number;
  combinedFunding: number;
  netDelta: number;
  spreadPnl: number | null;
}

// ─── Trade types ───────────────────────────────────────────────────────────

export const ORDER_TYPES = ['partial_fill', 'twap', 'single'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const POSITION_TYPES = [
  'scalp',
  'directional',
  'scaled_directional',
  'carry_trade',
  'market_making',
] as const;
export type PositionType = (typeof POSITION_TYPES)[number];

export const STRATEGY_TYPES = ['delta_neutral', 'pairs_trade', 'basis_trade'] as const;

// ─── Classifier interface ──────────────────────────────────────────────────

export interface ClassificationResult {
  type: string;
  confidence: number;
}

export interface Classifier<T> {
  readonly name: string;
  classify(item: T): ClassificationResult | null;
}

// ─── Pipeline summary ──────────────────────────────────────────────────────

export interface GroupingSummary {
  totalFills: number;
  totalOrders: number;
  totalPositions: number;
  totalLinkedStrategies: number;
  positionsByType: Record<string, number>;
  needsReview: number;
}
