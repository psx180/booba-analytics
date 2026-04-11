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
 *
 * Underwater curve: alongside the main cumulative series we track the
 * running high-water mark and emit an `underwaterSeries` (always ≤ 0)
 * showing the gap between current equity and HWM. Max drawdown, current
 * drawdown, and the longest underwater run (in trades) are exposed in
 * `data` so the WART risk axis and dashboard can read them without
 * re-walking the series.
 */

import * as ss from 'simple-statistics';
import type { Aggregator, Position } from './base';
import type { AggregationResult } from '../types';

export interface UnderwaterPoint {
  date: string;
  underwater: number;
  underwaterPct: number;
}

export const equityCurveAggregator: Aggregator = {
  name: 'equity-curve',

  aggregate(positions: Position[]): AggregationResult {
    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => (a.lastExitTime!.getTime()) - (b.lastExitTime!.getTime()));

    let cumulative = 0;
    let hwm = 0;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    // Track the longest run of consecutive trades spent strictly underwater
    // (cumulative < hwm). The current run resets every time we hit a new HWM.
    let currentRunLen = 0;
    let maxDrawdownDuration = 0;

    const series: { date: string; value: number; cumulativePnl: number; regime: string; positionId: string }[] = [];
    const underwaterSeries: UnderwaterPoint[] = [];

    for (const p of closed) {
      cumulative += p.aggregatePnl ?? 0;
      if (cumulative > hwm) hwm = cumulative;

      const underwater = cumulative - hwm; // ≤ 0
      const denom = Math.max(Math.abs(hwm), 1);
      const underwaterPct = (underwater / denom) * 100;

      if (underwater < 0) {
        currentRunLen += 1;
        if (currentRunLen > maxDrawdownDuration) {
          maxDrawdownDuration = currentRunLen;
        }
      } else {
        currentRunLen = 0;
      }

      if (underwater < maxDrawdown) {
        maxDrawdown = underwater;
        maxDrawdownPct = underwaterPct;
      }

      const date = p.lastExitTime!.toISOString();
      series.push({
        date,
        value: round(cumulative, 2),
        cumulativePnl: round(cumulative, 2),
        regime: p.regimeAtEntry ?? 'unknown',
        positionId: p.id,
      });
      underwaterSeries.push({
        date,
        underwater: round(underwater, 2),
        underwaterPct: round(underwaterPct, 2),
      });
    }

    const lastUnderwater = underwaterSeries.length > 0
      ? underwaterSeries[underwaterSeries.length - 1]
      : { underwater: 0, underwaterPct: 0 };

    return {
      name: 'equity-curve',
      data: {
        tradeCount: closed.length,
        finalPnl: round(cumulative, 2),
        consistency: round(consistencyR2(series), 4),
        hwm: round(hwm, 2),
        maxDrawdown: round(maxDrawdown, 2),
        maxDrawdownPct: round(maxDrawdownPct, 2),
        maxDrawdownDuration,
        currentDrawdown: round(lastUnderwater.underwater, 2),
        currentDrawdownPct: round(lastUnderwater.underwaterPct, 2),
        underwaterSeries,
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
