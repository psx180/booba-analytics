/**
 * Equity-curve aggregator.
 *
 * Sorts positions by firstEntryTime, then walks through them accumulating
 * P&L. Each data point carries the regime at entry so the frontend can
 * shade the background by regime band.
 */

import type { Aggregator, Position } from './base';
import type { AggregationResult } from '../types';

export const equityCurveAggregator: Aggregator = {
  name: 'equity-curve',

  aggregate(positions: Position[]): AggregationResult {
    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => (a.lastExitTime!.getTime()) - (b.lastExitTime!.getTime()));

    let cumulative = 0;
    const series = closed.map((p) => {
      cumulative += p.aggregatePnl ?? 0;
      return {
        date: p.lastExitTime!.toISOString(),
        value: round(cumulative, 2),
        cumulativePnl: round(cumulative, 2),
        regime: p.regimeAtEntry ?? 'unknown',
        positionId: p.id,
      };
    });

    return {
      name: 'equity-curve',
      data: {
        tradeCount: closed.length,
        finalPnl: round(cumulative, 2),
      },
      series,
    };
  },
};

function round(value: number, digits: number): number {
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}
