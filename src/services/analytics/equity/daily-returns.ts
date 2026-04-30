/**
 * Daily mark-to-market return analytics.
 *
 * Pulls every EquitySnapshot row for the wallet (Pacifica delivers roughly
 * hourly samples) and computes Time-Weighted Return at sub-period precision:
 * for each consecutive pair of snapshots, any cash flows whose timestamp
 * falls inside that interval are subtracted from the ending equity before
 * the percentage return is taken. The sub-period returns are then chained
 * back into per-UTC-day daily returns. This avoids the date-string
 * misalignment bug where a deposit at 23:30 was attributed to the same day
 * as a 23:00 snapshot that didn't yet reflect it — producing extreme
 * spurious daily returns.
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
 *   - Sharpe and Sortino are computed on the active-day series (idle days
 *     where every sub-period return is exactly zero are excluded; they
 *     represent no exposure and shouldn't anchor downside variance to zero).
 *   - Calmar uses the geometric CAGR of the FULL chained TWR daily returns
 *     (idle days contribute ×1 to the chain, which is correct for compound
 *     return), annualized as twrTotal^(252 / N) - 1, divided by |maxDD|.
 *   - Days with no equity snapshot are skipped, not interpolated.
 *
 * Pure data inputs only — no I/O outside of two read-only Prisma queries.
 * Returns null when the wallet has no snapshots at all (or every snapshot
 * has a non-finite equity); returns a summary with null ratios when there
 * are some snapshots but fewer than 30 active daily observations (still
 * surfaces the dailyEquity series for charts).
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
  /** Cash-flow-adjusted daily return chained from sub-period returns within
   *  the day. 0 for the first day in the series. */
  dailyReturn: number;
}

export interface DailyReturnsSummary {
  dailyReturns: number[];
  dailyEquity: DailyEquityPoint[];
  /** Count of ACTIVE daily-return observations (idle days where every
   *  sub-period return was exactly zero are excluded). This is the N
   *  Sharpe and Sortino are computed against. */
  tradingDays: number;
  /** Calendar span of the underlying snapshot data, inclusive (in days). */
  calendarDays: number;
  /** Geometric CAGR computed from the full chained TWR daily returns. */
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

interface TimedEquity {
  timestamp: number; // ms since epoch
  equity: number;
  date: string;      // UTC date for daily grouping later
}

interface SubPeriodReturn {
  timestamp: number;
  date: string;
  return: number;
}

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

  // ── Step 1 — keep every snapshot, tagged with its UTC date for grouping ──
  const timedEquity: TimedEquity[] = [];
  for (const s of snapshots) {
    if (s.accountEquity == null || !isFinite(s.accountEquity)) continue;
    timedEquity.push({
      timestamp: s.timestamp.getTime(),
      equity: s.accountEquity,
      date: utcDateKey(s.timestamp),
    });
  }
  if (timedEquity.length === 0) {
    // Defensive: every snapshot had a non-finite accountEquity.
    return null;
  }

  // ── Step 2 — sub-period returns at snapshot-pair timestamp precision ──
  // Cash flows that fall inside (prev.timestamp, curr.timestamp] are summed
  // and subtracted from curr.equity before taking the percentage return.
  // This is the actual fix: matching cash flows by real timestamps rather
  // than by date string keeps a deposit at 23:30 in the right sub-period
  // even when the previous snapshot was at 23:00 of the same calendar day.
  const sortedCashFlows = balanceEvents
    .filter((e) => classifyEvent(e.eventType) !== 'other')
    .map((e) => ({
      timestamp: e.timestamp.getTime(),
      amount: classifyEvent(e.eventType) === 'deposit' ? e.amount : -Math.abs(e.amount),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const subPeriodReturns: SubPeriodReturn[] = [];
  for (let i = 1; i < timedEquity.length; i++) {
    const prev = timedEquity[i - 1];
    const curr = timedEquity[i];
    if (prev.equity <= 0) continue; // can't compute return on zero/negative base

    const periodCashFlow = sortedCashFlows
      .filter((cf) => cf.timestamp > prev.timestamp && cf.timestamp <= curr.timestamp)
      .reduce((sum, cf) => sum + cf.amount, 0);

    const equityBeforeCashFlow = curr.equity - periodCashFlow;
    const subReturn = (equityBeforeCashFlow - prev.equity) / prev.equity;

    subPeriodReturns.push({
      timestamp: curr.timestamp,
      date: curr.date,
      return: subReturn,
    });
  }

  // ── Step 3 — chain sub-period returns into daily returns by UTC date ──
  const byDate = new Map<string, number[]>();
  for (const sp of subPeriodReturns) {
    const bucket = byDate.get(sp.date);
    if (bucket == null) byDate.set(sp.date, [sp.return]);
    else bucket.push(sp.return);
  }
  // Ensure the first snapshot's date is in the daily series even if its only
  // sub-period return landed on a later date (gap between snapshot 0 and 1).
  const firstDate = timedEquity[0].date;
  if (!byDate.has(firstDate)) byDate.set(firstDate, []);
  const sortedDates = [...byDate.keys()].sort();

  // Per-day cash-flow display values (used for the dailyEquity rows). The
  // returns themselves don't read from this map — they came from the
  // timestamp-precise sub-period filter above.
  const cashFlowByDay = new Map<string, number>();
  for (const e of balanceEvents) {
    const bucket = classifyEvent(e.eventType);
    if (bucket === 'other') continue;
    const day = utcDateKey(e.timestamp);
    const signed = bucket === 'deposit' ? e.amount : -Math.abs(e.amount);
    cashFlowByDay.set(day, (cashFlowByDay.get(day) ?? 0) + signed);
  }

  const dailyEquity: DailyEquityPoint[] = [];
  const dailyReturns: number[] = [];
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const lastEquityOfDay = timedEquity.filter((t) => t.date === date).pop()!.equity;
    const netCashFlow = cashFlowByDay.get(date) ?? 0;

    if (i === 0) {
      // First day in the window — no prior close to compare against, so its
      // intraday sub-returns (if any) are not chained into a daily return.
      dailyEquity.push({ date, equity: lastEquityOfDay, netCashFlow, dailyReturn: 0 });
      continue;
    }

    const subReturns = byDate.get(date)!;
    const chainedReturn = subReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;

    dailyEquity.push({ date, equity: lastEquityOfDay, netCashFlow, dailyReturn: chainedReturn });
    dailyReturns.push(chainedReturn);
  }

  // ── Step 3b — active-day series for Sharpe/Sortino ──
  // Days where every sub-period return was exactly zero (no exposure) chain
  // to a daily return of exactly 0. Including them deflates volatility and
  // anchors downside variance to zero, which is what produced the bogus
  // Sortino in the 8000s. Drop them from the Sharpe/Sortino input series;
  // they remain in dailyEquity for drawdown and in dailyReturns for Calmar.
  const activeDailyReturns = dailyReturns.filter((r) => r !== 0);
  console.log(
    `[daily-returns] ${dailyReturns.length} total days, ` +
    `${activeDailyReturns.length} active, ` +
    `${dailyReturns.length - activeDailyReturns.length} idle excluded from Sharpe/Sortino`,
  );

  // Sanity-check: any daily returns exceeding ±100% should be very rare.
  // They might be real (a single-day liquidation hit) or residual
  // misalignment that survived the timestamp-precise rewrite. Surface them
  // so we notice — but don't clamp; if a liquidation produced -95% in one
  // day, that's accurate data and should flow through to the ratios.
  const extremeReturns = dailyReturns
    .map((r, i) => ({ date: sortedDates[i + 1], return: r }))
    .filter((d) => Math.abs(d.return) > 1.0);
  if (extremeReturns.length > 0) {
    console.warn(
      `[daily-returns] WARNING: ${extremeReturns.length} daily returns exceed ±100%: ` +
      extremeReturns.map((d) => `${d.date}: ${(d.return * 100).toFixed(1)}%`).join(', ') +
      ' — These may be real (liquidation events) or residual misalignment. Investigate if unexpected.',
    );
  }

  const calendarDays = calendarSpanDays(sortedDates);

  // ── Step 4 — drawdown loop (per spec; counts duration after each new peak)
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

  // ── Step 5 — Sharpe / Sortino / Calmar ──
  let dailySharpe: number | null = null;
  let dailySortino: number | null = null;
  let dailyCalmar: number | null = null;
  let annualizedReturn = 0;

  if (activeDailyReturns.length >= MIN_DAYS_FOR_RATIOS) {
    const m = mean(activeDailyReturns);
    const sd = sampleStddev(activeDailyReturns);
    if (sd > 0) {
      dailySharpe = (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }

    // Sortino: divide by N (all active days), not by negative-day count.
    const sumNegativeSquared = activeDailyReturns.reduce(
      (s, r) => s + (r < 0 ? r * r : 0),
      0,
    );
    const downsideDev = Math.sqrt(sumNegativeSquared / activeDailyReturns.length);
    if (downsideDev > 0) {
      dailySortino = (m / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }
  }

  // Calmar uses the FULL daily-return chain (idle days contribute ×1, which
  // is correct for compound return). Idle days extend the denominator,
  // slightly suppressing the annualized rate — also correct.
  if (dailyReturns.length > 0) {
    const twrTotal = dailyReturns.reduce((acc, r) => acc * (1 + r), 1);
    const twrCagr = Math.pow(twrTotal, TRADING_DAYS_PER_YEAR / dailyReturns.length) - 1;
    annualizedReturn = twrCagr;
    if (isFinite(twrCagr) && maxDrawdownPct !== 0) {
      dailyCalmar = twrCagr / Math.abs(maxDrawdownPct / 100);
    }
  }

  console.log(
    `[daily-returns] ${walletAddress}: ${dailyEquity.length} daily points, ` +
    `${dailyReturns.length} returns (${activeDailyReturns.length} active), ` +
    `Sharpe=${dailySharpe?.toFixed(4) ?? 'null'}, ` +
    `Sortino=${dailySortino?.toFixed(4) ?? 'null'}, ` +
    `Calmar=${dailyCalmar?.toFixed(4) ?? 'null'}`,
  );

  return {
    dailyReturns,
    dailyEquity,
    tradingDays: activeDailyReturns.length,
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
