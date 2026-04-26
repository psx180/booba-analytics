/**
 * Derive a Monte Carlo input from closed positions + reconstructed equity.
 *
 * Mirrors the equity-based per-trade-return logic from
 * src/app/api/analytics/monte-carlo/route.ts so the report's Monte Carlo
 * section sees the same numbers a user gets when they hit the Monte Carlo
 * page directly. The route file is left untouched (per project policy);
 * this is a stand-alone helper the report module owns.
 */

import type { Position } from '../../../generated/prisma/client';
import type { EquityPoint } from '../analytics/equity/types';
import type { MonteCarloInput } from '../analytics/monte-carlo';

const MAX_RETURN_PCT = 200;
const MIN_VALID_TRADES = 20;

export interface DerivedMonteCarloInput {
  input: MonteCarloInput;
  validCount: number;
  initialBalance: number;
}

/**
 * Returns null when there aren't enough valid trades for a reliable
 * simulation (matches the route's 422 behaviour). Callers treat null as
 * "Monte Carlo section unavailable".
 */
export function deriveMonteCarloInput(
  positions: Position[],
  equityCurve: EquityPoint[],
): DerivedMonteCarloInput | null {
  // Re-apply the same closed-and-valid predicate the equity provider does so
  // index parity with equityCurve holds. Without this, a position with a
  // null aggregatePnl or lastExitTime would be present in `sorted` but
  // missing from equityCurve, silently misaligning indices.
  const sorted = positions
    .filter((p) => p.aggregatePnl != null && p.lastExitTime != null && p.status === 'closed')
    .sort((a, b) => (a.lastExitTime!.getTime()) - (b.lastExitTime!.getTime()));

  if (sorted.length === 0 || equityCurve.length === 0) return null;

  const winReturnPcts: number[] = [];
  const lossReturnPcts: number[] = [];
  let grossWins = 0;
  let grossLosses = 0;
  let validCount = 0;

  const len = Math.min(sorted.length, equityCurve.length);
  for (let i = 0; i < len; i++) {
    const pt = equityCurve[i];
    const pnl = sorted[i].aggregatePnl ?? 0;

    // Recover the equity at entry — for the first trade, back it out of the
    // current equity point; for later trades use the prior point.
    const equityAtEntry = i === 0 ? pt.equity - pnl : equityCurve[i - 1].equity;
    if (equityAtEntry <= 0) continue;

    let pnlPct = (pnl / equityAtEntry) * 100;
    if (Math.abs(pnlPct) > MAX_RETURN_PCT) {
      pnlPct = Math.sign(pnlPct) * MAX_RETURN_PCT;
    }

    validCount++;
    if (pnlPct > 0) {
      winReturnPcts.push(pnlPct);
      grossWins += pnlPct;
    } else if (pnlPct < 0) {
      lossReturnPcts.push(pnlPct);
      grossLosses += Math.abs(pnlPct);
    }
  }

  if (validCount < MIN_VALID_TRADES) return null;

  const winCount = winReturnPcts.length;
  const lossCount = lossReturnPcts.length;
  const winRate = winCount / validCount;
  const avgWinPct = winCount > 0 ? grossWins / winCount : 0;
  const avgLossPct = lossCount > 0 ? -(grossLosses / lossCount) : 0;
  const initialBalance = 10000;

  return {
    validCount,
    initialBalance,
    input: {
      winRate,
      avgWinPct,
      avgLossPct,
      tradeCount: 100,
      simulations: 10000,
      initialBalance,
      winReturnPcts: winCount > 0 ? winReturnPcts : undefined,
      lossReturnPcts: lossCount > 0 ? lossReturnPcts : undefined,
    },
  };
}
