/**
 * Base helpers for aggregators.
 *
 * Aggregators read a list of positions (already filtered by the service)
 * and return an AggregationResult. They never mutate state, never store
 * anything, and never query the database directly.
 *
 * Performance stats are computed here in a single reusable function so
 * breakdown and what-if can slice the same way performance does.
 */

import type { Aggregator, Position } from '../types';

export type { Aggregator, Position };

export interface PerformanceStats {
  tradeCount: number;
  winRate: number;         // fraction 0-1
  lossRate: number;        // fraction 0-1
  averageWin: number;
  averageLoss: number;     // negative number
  expectancy: number;      // average $ per trade
  profitFactor: number;    // gross wins / gross losses, or 999 if no losses
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
}

export function computePerformanceStats(positions: Position[]): PerformanceStats {
  const stats: PerformanceStats = {
    tradeCount: 0,
    winRate: 0,
    lossRate: 0,
    averageWin: 0,
    averageLoss: 0,
    expectancy: 0,
    profitFactor: 0,
    totalPnl: 0,
    totalFees: 0,
    totalFunding: 0,
  };

  if (positions.length === 0) return stats;

  let wins = 0;
  let losses = 0;
  let grossWins = 0;
  let grossLosses = 0;

  for (const p of positions) {
    const pnl = p.aggregatePnl ?? 0;
    stats.totalPnl += pnl;
    stats.totalFees += p.aggregateFees ?? 0;
    stats.totalFunding += p.aggregateFunding ?? 0;

    if (pnl > 0) {
      wins++;
      grossWins += pnl;
    } else if (pnl < 0) {
      losses++;
      grossLosses += Math.abs(pnl);
    }
  }

  const n = positions.length;
  stats.tradeCount = n;
  stats.winRate = wins / n;
  stats.lossRate = losses / n;
  stats.averageWin = wins > 0 ? grossWins / wins : 0;
  stats.averageLoss = losses > 0 ? -grossLosses / losses : 0;
  stats.expectancy = stats.totalPnl / n;
  stats.profitFactor = grossLosses > 0
    ? grossWins / grossLosses
    : grossWins > 0 ? 999 : 0;

  return roundStats(stats);
}

function roundStats(s: PerformanceStats): PerformanceStats {
  return {
    tradeCount: s.tradeCount,
    winRate: round(s.winRate, 4),
    lossRate: round(s.lossRate, 4),
    averageWin: round(s.averageWin, 2),
    averageLoss: round(s.averageLoss, 2),
    expectancy: round(s.expectancy, 2),
    profitFactor: s.profitFactor === 999 ? 999 : round(s.profitFactor, 2),
    totalPnl: round(s.totalPnl, 2),
    totalFees: round(s.totalFees, 2),
    totalFunding: round(s.totalFunding, 2),
  };
}

function round(value: number, digits: number): number {
  if (!isFinite(value)) return 0;
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}