/**
 * What-if aggregator.
 *
 * Runs the performance aggregator twice — once on the base position set and
 * once on the subset matching an additional hypothetical filter — and
 * reports the delta.
 *
 * Example use: "what would my stats look like if I removed all trades that
 * weren't in trending regimes?" → pass `regime=trending_low_vol` as the
 * hypothetical filter and compare.
 */

import type { Position } from './base';
import { computePerformanceStats } from './base';
import type { AggregationResult, Filters } from '../types';

export interface WhatIfOptions {
  hypotheticalFilter: Filters;
}

export const whatIfAggregator = {
  name: 'what-if',

  aggregate(positions: Position[], options: WhatIfOptions): AggregationResult {
    const base = computePerformanceStats(positions);
    const filtered = computePerformanceStats(applyFilter(positions, options.hypotheticalFilter));

    const delta: Record<string, number> = {};
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      const a = base[key] as number;
      const b = filtered[key] as number;
      if (typeof a === 'number' && typeof b === 'number') {
        delta[key] = round(b - a, 2);
      }
    }

    return {
      name: 'what-if',
      data: {
        base,
        filtered,
        delta,
        hypotheticalFilter: options.hypotheticalFilter,
      },
    };
  },
};

function applyFilter(positions: Position[], filter: Filters): Position[] {
  return positions.filter((p) => {
    if (filter.regime && (p.regimeAtEntry ?? 'unknown') !== filter.regime) return false;
    if (filter.asset && p.asset !== filter.asset) return false;
    if (filter.strategy && p.strategyId !== filter.strategy) return false;
    if (filter.tradeType && p.tradeType !== filter.tradeType) return false;
    if (filter.dateFrom && p.firstEntryTime && p.firstEntryTime < filter.dateFrom) return false;
    if (filter.dateTo && p.firstEntryTime && p.firstEntryTime > filter.dateTo) return false;
    return true;
  });
}

function round(value: number, digits: number): number {
  if (!isFinite(value)) return 0;
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}