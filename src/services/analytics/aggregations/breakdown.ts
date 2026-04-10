/**
 * Breakdown aggregator.
 *
 * General-purpose grouping aggregator. Takes a dimension name and returns
 * full performance stats for each distinct value of that dimension.
 *
 * Supported dimensions: regime, asset, strategy, source, tradeType,
 * entryHour, entryDayOfWeek, entrySession, holdTimeCategory.
 *
 * The dimension is passed via filters.groupBy — which isn't on the Filters
 * interface because it isn't a filter — so this aggregator has its own
 * invocation contract. The analytics service special-cases it.
 */

import type { Aggregator, Position } from './base';
import { computePerformanceStats } from './base';
import type { AggregationResult } from '../types';

export type BreakdownDimension =
  | 'regime'
  | 'asset'
  | 'strategy'
  | 'source'
  | 'tradeType'
  | 'entryHour'
  | 'entryDayOfWeek'
  | 'entrySession'
  | 'holdTimeCategory'
  | 'date';

export interface BreakdownOptions {
  groupBy: BreakdownDimension;
}

export const breakdownAggregator = {
  name: 'breakdown',

  aggregate(positions: Position[], options: BreakdownOptions): AggregationResult {
    const groupBy = options?.groupBy ?? 'regime';
    const buckets: Record<string, Position[]> = {};

    for (const p of positions) {
      const key = getDimensionValue(p, groupBy);
      (buckets[key] ??= []).push(p);
    }

    const breakdown: Record<string, Record<string, any>> = {};
    for (const [key, bucket] of Object.entries(buckets)) {
      breakdown[key] = computePerformanceStats(bucket) as unknown as Record<string, any>;
    }

    return {
      name: 'breakdown',
      data: { groupBy, groupCount: Object.keys(buckets).length },
      breakdowns: { [groupBy]: breakdown },
    };
  },
};

function getDimensionValue(p: Position, dim: BreakdownDimension): string {
  switch (dim) {
    case 'regime':          return p.regimeAtEntry ?? 'unknown';
    case 'asset':           return p.asset;
    case 'strategy':        return p.strategyId ?? 'none';
    case 'source':          return readSource(p);
    case 'tradeType':       return p.tradeType ?? 'unknown';
    case 'entryHour':       return p.entryHour != null ? String(p.entryHour) : 'unknown';
    case 'entryDayOfWeek':  return p.entryDayOfWeek != null ? String(p.entryDayOfWeek) : 'unknown';
    case 'entrySession':    return p.entrySession ?? 'unknown';
    case 'holdTimeCategory': return p.holdTimeCategory ?? 'unknown';
    case 'date':             return p.firstEntryTime ? p.firstEntryTime.toISOString().slice(0, 10) : 'unknown';
  }
}

/** Position has no direct source tag — read it from customData if present. */
function readSource(p: Position): string {
  if (!p.customData) return 'unknown';
  try {
    const data = JSON.parse(p.customData);
    return data.source ?? data.sourceTag ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
