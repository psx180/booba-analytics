/**
 * Daily mark-to-market return analytics.
 *
 * Pulls hourly EquitySnapshot rows from the database, resamples to one
 * end-of-day equity per UTC calendar day, removes the effect of cash flows
 * (deposits/withdrawals) via TWR sub-period adjustment, and computes the
 * standard suite of risk-adjusted return metrics off the resulting daily
 * return series.
 *
 * Methodology choices follow the cleanup spec:
 *
 *   - Annualization factor for Sharpe/Sortino is √252 (industry standard,
 *     comparable with traditional finance — using 365 because crypto trades
 *     24/7 would make these numbers non-comparable).
 *   - Sample standard deviation (n-1 denominator) for Sharpe.
 *   - Sortino's downside deviation divides by N (all observations), not by
 *     the count of negative returns. Each non-negative day contributes 0 to
 *     the sum but still counts in the denominator. This is the Sortino 1980
 *     original formulation; both audits flagged the previous approach.
 *   - Calmar uses the geometric CAGR of the chained TWR daily returns,
 *     annualized as twrTotal^(252 / N) - 1, divided by |maxDrawdown|.
 *   - Days with no equity snapshot are skipped, not interpolated.
 *
 * Pure data inputs only — no I/O outside of two read-only Prisma queries.
 * Returns null when the wallet has no snapshots at all; returns a summary
 * with null ratios when there are some snapshots but fewer than 30 distinct
 * daily observations (still surfaces the dailyEquity series for charts).
 */

import { prisma } from '../../../lib/prisma';

// ─── Output types ──────────────────────────────────────────────────────────

export interface DailyEquityPoint {
  /** UTC calendar date in YYYY-MM-DD form. */
  date: string;
  /** Last observed account equity for that day (mark-to-market). */
  equity: number;
  /** Net cash flow on that day (deposits - withdrawals). */
  netCashFlow: number;
  /** Cash-flow-adjusted daily return from the previous observed day.
   *  0 for the first day in the series. */
  dailyReturn: number;
}

export interface DailyReturnsSummary {
  dailyReturns: number[];
  dailyEquity: DailyEquityPoint[];
  /** Count of distinct daily-return observations (= dailyEquity.length - 1
   *  minus any skipped-divide-by-non-positive-equity days). */
  tradingDays: number;
  /** Calendar span of the underlying snapshot data, inclusive (in days). */
  calendarDays: number;
  /** Geometric CAGR computed from the chained TWR daily returns. */
  annualizedReturn: number;
  dailySharpe: number | null;
  dailySortino: number | null;
  dailyCalmar: number | null;
  /** Worst peak-to-trough drawdown as a percentage, e.g. -23.4 for -23.4%. */
  maxDrawdownPct: number;
  /** Average across all per-day drawdown values (used for diagnostics). */
  avgDrawdownPct: number;
  /** Root-mean-square of per-day drawdown percentages (depth × duration). */
  ulcerIndex: number;
  /** Longest run of consecutive days under water (calendar days). */
  maxDrawdownDuration: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_DAYS_FOR_RATIOS = 30;
const TRADING_DAYS_PER_YEAR = 252;

// ─── Public API ───────────────────────────────────────────────────────────

export async function computeDailyReturns(
  walletAddress: string,
): Promise<DailyReturnsSummary | null> {
  const snapshots = await prisma.equitySnapshot.findMany({
    where: { walletAddress },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, accountEquity: true },
  });

  if (snapshots.length === 0) {
    return null;
  }

  const balanceEvents = await prisma.balanceEvent.findMany({
    where: { walletAddress },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, eventType: true, amount: true },
  });

  // Step 1 — resample to last-snapshot-per-UTC-day.
  const lastEquityByDay = new Map<string, number>();
  for (const s of snapshots) {
    if (s.accountEquity == null || !isFinite(s.accountEquity)) continue;
    const day = utcDateKey(s.timestamp);
    lastEquityByDay.set(day, s.accountEquity);
  }

  // Step 2 — net cash flow per day (deposits - withdrawals).
  const cashFlowByDay = new Map<string, number>();
  for (const e of balanceEvents) {
    const bucket = classifyEvent(e.eventType);
    if (bucket === 'other') continue;
    const day = utcDateKey(e.timestamp);
    const signed = bucket === 'deposit' ? e.amount : -Math.abs(e.amount);
    cashFlowByDay.set(day, (cashFlowByDay.get(day) ?? 0) + signed);
  }

  // Step 3 — assemble the daily series in chronological order.
  const sortedDays = [...lastEquityByDay.keys()].sort();
  const dailyEquity: DailyEquityPoint[] = [];
  const dailyReturns: number[] = [];

  for (let i = 0; i < sortedDays.length; i++) {
    const day = sortedDays[i];
    const equity = lastEquityByDay.get(day)!;
    const netCashFlow = cashFlowByDay.get(day) ?? 0;

    if (i === 0) {
      dailyEquity.push({ date: day, equity, netCashFlow, dailyReturn: 0 });
      continue;
    }

    const yesterdayEquity = dailyEquity[dailyEquity.length - 1].equity;
    if (yesterdayEquity <= 0) {
      // Defensive: can't compute a return off a non-positive base.
      dailyEquity.push({ date: day, equity, netCashFlow, dailyReturn: 0 });
      continue;
    }

    // Cash-flow-adjusted (TWR sub-period) daily return.
    const equityBeforeCashFlow = equity - netCashFlow;
    const dailyReturn = (equityBeforeCashFlow - yesterdayEquity) / yesterdayEquity;

    dailyEquity.push({ date: day, equity, netCashFlow, dailyReturn });
    dailyReturns.push(dailyReturn);
  }

  const calendarDays = calendarSpanDays(sortedDays);

  // Step 4 — drawdown loop (per spec; counts duration after each new peak).
  let peak = dailyEquity[0].equity;
  let maxDD = 0;
  let maxDDDuration = 0;
  let ddDays = 0;
  let sumDDSquared = 0;
  let sumDD = 0;

  for (const point of dailyEquity) {
    if (point.equity > peak) {
      peak = point.equity;
      ddDays = 0;
    }
    const dd = peak > 0 ? (point.equity - peak) / peak : 0; // negative or zero
    if (dd < maxDD) {
      maxDD = dd;
    }
    ddDays++;
    if (ddDays > maxDDDuration && dd < 0) {
      maxDDDuration = ddDays;
    }
    sumDDSquared += dd * dd;
    sumDD += dd;
  }

  const maxDrawdownPct = maxDD * 100;
  const avgDrawdownPct = (sumDD / dailyEquity.length) * 100;
  const ulcerIndex = Math.sqrt(sumDDSquared / dailyEquity.length) * 100;

  // Step 5 — Sharpe / Sortino / Calmar from the daily return series.
  let dailySharpe: number | null = null;
  let dailySortino: number | null = null;
  let dailyCalmar: number | null = null;
  let annualizedReturn = 0;

  if (dailyReturns.length >= MIN_DAYS_FOR_RATIOS) {
    const m = mean(dailyReturns);
    const sd = sampleStddev(dailyReturns);
    if (sd > 0) {
      dailySharpe = (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }

    // Sortino: divide by N (all days), not by negative-day count.
    const sumNegativeSquared = dailyReturns.reduce(
      (s, r) => s + (r < 0 ? r * r : 0),
      0,
    );
    const downsideDev = Math.sqrt(sumNegativeSquared / dailyReturns.length);
    if (downsideDev > 0) {
      dailySortino = (m / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }

    // Calmar: TWR-chained CAGR over the observed return series, divided by
    // |maxDrawdown|. Annualize with 252-trading-day convention.
    const twrTotal = dailyReturns.reduce((acc, r) => acc * (1 + r), 1);
    const twrCagr = Math.pow(twrTotal, TRADING_DAYS_PER_YEAR / dailyReturns.length) - 1;
    annualizedReturn = twrCagr;
    if (maxDrawdownPct !== 0) {
      dailyCalmar = twrCagr / Math.abs(maxDrawdownPct / 100);
    }
  }

  console.log(
    `[daily-returns] ${walletAddress}: ${dailyEquity.length} daily points, ` +
    `${dailyReturns.length} returns, ` +
    `Sharpe=${dailySharpe?.toFixed(4) ?? 'null'}, ` +
    `Sortino=${dailySortino?.toFixed(4) ?? 'null'}, ` +
    `Calmar=${dailyCalmar?.toFixed(4) ?? 'null'}`,
  );

  return {
    dailyReturns,
    dailyEquity,
    tradingDays: dailyReturns.length,
    calendarDays,
    annualizedReturn,
    dailySharpe,
    dailySortino,
    dailyCalmar,
    maxDrawdownPct,
    avgDrawdownPct,
    ulcerIndex,
    maxDrawdownDuration: maxDDDuration,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function calendarSpanDays(sortedDayKeys: string[]): number {
  if (sortedDayKeys.length === 0) return 0;
  const first = new Date(sortedDayKeys[0] + 'T00:00:00.000Z').getTime();
  const last  = new Date(sortedDayKeys[sortedDayKeys.length - 1] + 'T00:00:00.000Z').getTime();
  return Math.max(1, Math.round((last - first) / (1000 * 60 * 60 * 24)) + 1);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function sampleStddev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1);
  return Math.sqrt(variance);
}

function classifyEvent(eventType: string): 'deposit' | 'withdrawal' | 'other' {
  const lower = eventType.toLowerCase();
  if (lower.includes('deposit')) return 'deposit';
  if (lower.includes('withdraw')) return 'withdrawal';
  return 'other';
}
