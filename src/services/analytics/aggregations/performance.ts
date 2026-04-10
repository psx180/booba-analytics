/**
 * Performance aggregator.
 *
 * Computes headline performance stats (win rate, expectancy, profit factor,
 * P&L, fees, funding) for a set of positions, plus a regime breakdown of
 * the same stats.
 */

import type { Aggregator, Position } from './base';
import { computePerformanceStats } from './base';
import type { AggregationResult } from '../types';

export const performanceAggregator: Aggregator = {
  name: 'performance',

  aggregate(positions: Position[]): AggregationResult {
    const overall = computePerformanceStats(positions);

    const regimeBuckets: Record<string, Position[]> = {};
    for (const p of positions) {
      const r = p.regimeAtEntry ?? 'unknown';
      (regimeBuckets[r] ??= []).push(p);
    }

    const regimeBreakdown: Record<string, Record<string, any>> = {};
    for (const [regime, bucket] of Object.entries(regimeBuckets)) {
      regimeBreakdown[regime] = computePerformanceStats(bucket) as unknown as Record<string, any>;
    }

    return {
      name: 'performance',
      data: overall as unknown as Record<string, any>,
      breakdowns: { regime: regimeBreakdown },
    };
  },
};
