/**
 * Equity-curve aggregator.
 *
 * Sorts positions by firstEntryTime, then walks through them accumulating
 * P&L. Each data point carries the regime at entry so the frontend can
 * shade the background by regime band.
 *
 * Also fits a linear regression `cumulativePnl ~ tradeIndex` and exposes the
 * R² as a "consistency" score: 1.0 = a perfectly straight equity curve,
 * 0.0 = totally erratic. Used by the dashboard to summarise growth quality
 * with a single number.
 */

import * as ss from 'simple-statistics';
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
        consistency: round(consistencyR2(series), 4),
      },
      series,
    };
  },
};

/**
 * R² of `cumulativePnl ~ tradeIndex` linear fit.
 *
 * simple-statistics' linearRegressionLine produces a function we can hand to
 * `rSquared` along with the points themselves. With <2 trades there's no
 * fit possible — return 0 rather than NaN so consumers don't have to
 * special-case empty histories.
 */
function consistencyR2(series: { cumulativePnl: number }[]): number {
  if (series.length < 2) return 0;
  const data = series.map((p, i) => [i, p.cumulativePnl] as [number, number]);
  const line = ss.linearRegressionLine(ss.linearRegression(data));
  const r2 = ss.rSquared(data, line);
  if (!isFinite(r2)) return 0;
  return Math.max(0, Math.min(1, r2));
}

function round(value: number, digits: number): number {
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}
