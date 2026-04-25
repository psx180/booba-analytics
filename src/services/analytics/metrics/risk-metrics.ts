/**
 * risk-metrics.ts — Risk-adjusted performance metrics.
 *
 * Computes Sharpe ratio, Sortino ratio, payoff ratio, recovery factor,
 * drawdown analysis (days-based), fee/funding attribution, and R-multiples
 * from a set of closed positions.
 *
 * All computations are pure (no DB calls). Pass the closed positions array
 * from the wallet/journal in chronological order (by lastExitTime).
 */

import type { Position } from '../../../../generated/prisma/client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DrawdownAnalysis {
  maxDrawdown: number;              // worst dollar drawdown (negative)
  maxDrawdownPercent: number;       // max drawdown as % of peak equity
  currentDrawdown: number;         // current $ gap below HWM (0 if at HWM)
  currentDrawdownDuration: number; // days since last equity high
  avgDrawdownDuration: number;     // average days to recover from drawdowns
  drawdownCount: number;           // episodes where equity dropped >5% from peak
  longestDrawdown: number;         // longest days below HWM
}

export interface FeeAttribution {
  totalFees: number;
  totalFunding: number;
  directionalPnl: number;   // P&L from price movement (totalPnl - totalFunding)
  feeImpact: number;        // fees as % of gross P&L (gross wins)
  fundingImpact: number;    // funding as % of total realized P&L
}

export interface RMultipleDistribution {
  positive: number;
  negative: number;
  avgPositive: number;
  avgNegative: number;
}

export interface RiskMetrics {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  payoffRatio: number | null;
  recoveryFactor: number | null;
  drawdownAnalysis: DrawdownAnalysis;
  feeAttribution: FeeAttribution;
  avgRMultiple: number | null;
  rMultipleDistribution: RMultipleDistribution | null;
  /** Number of closed positions the ratios are computed from. */
  tradeCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** Downside deviation — stddev of negative values only (treated as 0 when positive). */
function downsideDeviation(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const downside = values.map((v) => Math.min(v, 0));
  const variance = downside.reduce((s, v) => s + v ** 2, 0) / n;
  return Math.sqrt(variance);
}

// ── Main computation ───────────────────────────────────────────────────────────

const MIN_TRADES_FOR_RATIOS = 10;
const FALLBACK_STARTING_CAPITAL = 10000;

/**
 * Build per-trade percent returns using the account's starting equity as the
 * denominator rather than position notional. Pacifica runs on cross margin —
 * the entire account backs every open position — so equity is the correct
 * denominator for "how much of my capital did this trade swing." Notional
 * (entryPrice × size) compresses returns by the leverage factor and makes
 * Sharpe look artificially near-zero on leveraged accounts.
 *
 * Equity at entry is approximated as startingCapital plus cumulative realized
 * P&L up to (but not including) this trade's close. We don't thread deposits
 * and withdrawals through here — an async BalanceEvent lookup isn't in scope
 * for this pure helper; the reconstructed provider supplies the starting
 * capital that anchors the series.
 */
function computeReturnsWithEquityDenominator(
  sorted: Position[],
  startingCapital: number,
): number[] {
  const returns: number[] = [];
  let cumulativePnl = 0;

  for (const p of sorted) {
    const equityAtEntry = startingCapital + cumulativePnl;
    const pnl = p.aggregatePnl ?? 0;
    cumulativePnl += pnl;

    if (equityAtEntry > 0) {
      returns.push((pnl / equityAtEntry) * 100); // percent of equity at risk
    }
    // Equity ≤ 0 means the account was wiped out before this trade — skip
    // rather than divide by zero or a negative.
  }

  return returns;
}

export function computeRiskMetrics(
  positions: Position[],
  startingCapital: number = FALLBACK_STARTING_CAPITAL,
): RiskMetrics {
  const closed = positions
    .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
    .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

  const n = closed.length;

  // ── Per-trade returns: pnl / equity-at-entry, expressed as percent ─────────
  const returns = computeReturnsWithEquityDenominator(closed, startingCapital);

  // ── Annualization factor ───────────────────────────────────────────────────
  // Per-trade Sharpe with no annualization is hard to compare against TradFi
  // benchmarks. Scale by √(trades per year) using the actual calendar span
  // between the first entry and the last exit. A daily trader (≈250 trades
  // over 250 days) lands at √365 ≈ 19×; a once-a-week trader lands at √52 ≈
  // 7×. Infrequent traders get a smaller factor, which correctly reflects
  // fewer compounding opportunities.
  let annualization = 1;
  if (n >= 2 && closed[0].firstEntryTime && closed[n - 1].lastExitTime) {
    const firstMs = closed[0].firstEntryTime!.getTime();
    const lastMs  = closed[n - 1].lastExitTime!.getTime();
    const days = Math.max(1, (lastMs - firstMs) / (1000 * 60 * 60 * 24));
    const tradesPerYear = (n / days) * 365;
    annualization = Math.sqrt(tradesPerYear);
  }

  // ── Sharpe ratio ───────────────────────────────────────────────────────────
  let sharpeRatio: number | null = null;
  if (n >= MIN_TRADES_FOR_RATIOS) {
    const m = mean(returns);
    const sd = stddev(returns);
    if (sd > 0) {
      sharpeRatio = round4((m / sd) * annualization);
    }
  }

  // ── Sortino ratio ──────────────────────────────────────────────────────────
  let sortinoRatio: number | null = null;
  if (n >= MIN_TRADES_FOR_RATIOS) {
    const m = mean(returns);
    const dd = downsideDeviation(returns);
    if (dd > 0) {
      sortinoRatio = round4((m / dd) * annualization);
    }
  }

  // ── Payoff ratio ───────────────────────────────────────────────────────────
  const winPnls  = closed.filter((p) => (p.aggregatePnl ?? 0) > 0).map((p) => p.aggregatePnl!);
  const lossPnls = closed.filter((p) => (p.aggregatePnl ?? 0) < 0).map((p) => p.aggregatePnl!);
  const avgWin   = winPnls.length  > 0 ? mean(winPnls)  : 0;
  const avgLoss  = lossPnls.length > 0 ? mean(lossPnls) : 0; // negative number

  let payoffRatio: number | null = null;
  if (avgWin > 0 && avgLoss < 0) {
    payoffRatio = round2(avgWin / Math.abs(avgLoss));
  }

  // ── Drawdown analysis (days-based) ─────────────────────────────────────────
  const drawdownAnalysis = computeDrawdownAnalysis(closed, startingCapital);

  // ── Recovery factor ────────────────────────────────────────────────────────
  // Recovery factor is "net profit / max drawdown" — only meaningful when
  // profit is positive. A negative recovery factor reads like a metric value
  // but actually means the trader is in net loss; suppress to null in that
  // case so the UI doesn't render a misleading number.
  const totalPnl = closed.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
  let recoveryFactor: number | null = null;
  if (drawdownAnalysis.maxDrawdown < 0 && totalPnl > 0) {
    recoveryFactor = round2(totalPnl / Math.abs(drawdownAnalysis.maxDrawdown));
  }

  // ── Calmar ratio ───────────────────────────────────────────────────────────
  // Annualized total return (as % of equity) divided by the max drawdown %.
  // Summing the per-trade percent returns gives a simple (non-compounded)
  // approximation of the cumulative return over the measurement window; we
  // scale it up to a year using the same calendar span as Sharpe.
  let calmarRatio: number | null = null;
  if (
    n >= MIN_TRADES_FOR_RATIOS &&
    drawdownAnalysis.maxDrawdownPercent > 0 &&
    closed[0].firstEntryTime &&
    closed[n - 1].lastExitTime
  ) {
    const totalReturnPct = returns.reduce((s, r) => s + r, 0);
    const firstMs = closed[0].firstEntryTime!.getTime();
    const lastMs  = closed[n - 1].lastExitTime!.getTime();
    const days = Math.max(1, (lastMs - firstMs) / (1000 * 60 * 60 * 24));
    const annualizedReturnPct = (totalReturnPct / days) * 365;
    calmarRatio = round4(annualizedReturnPct / drawdownAnalysis.maxDrawdownPercent);
  }

  // ── Fee attribution ────────────────────────────────────────────────────────
  const feeAttribution = computeFeeAttribution(closed, totalPnl);

  // ── R-multiples ────────────────────────────────────────────────────────────
  let avgRMultiple: number | null = null;
  let rMultipleDistribution: RMultipleDistribution | null = null;

  if (n >= MIN_TRADES_FOR_RATIOS) {
    const rMultiples = computeRMultiples(closed);
    if (rMultiples.length >= MIN_TRADES_FOR_RATIOS) {
      avgRMultiple = round2(mean(rMultiples));
      const positive = rMultiples.filter((r) => r > 0);
      const negative = rMultiples.filter((r) => r < 0);
      rMultipleDistribution = {
        positive: positive.length,
        negative: negative.length,
        avgPositive: positive.length > 0 ? round2(mean(positive)) : 0,
        avgNegative: negative.length > 0 ? round2(mean(negative)) : 0,
      };
    }
  }

  console.log(
    `[risk] Sharpe: ${sharpeRatio} Sortino: ${sortinoRatio} Calmar: ${calmarRatio} ` +
      `trades: ${n} annualization: ${annualization.toFixed(2)} ` +
      `startingCapital: ${startingCapital}`,
  );

  return {
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    payoffRatio,
    recoveryFactor,
    drawdownAnalysis,
    feeAttribution,
    avgRMultiple,
    rMultipleDistribution,
    tradeCount: n,
  };
}

// ── Drawdown computation ───────────────────────────────────────────────────────

function computeDrawdownAnalysis(
  sorted: Position[], // pre-sorted by lastExitTime, closed only
  startingCapital: number,
): DrawdownAnalysis {
  const empty: DrawdownAnalysis = {
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    currentDrawdown: 0,
    currentDrawdownDuration: 0,
    avgDrawdownDuration: 0,
    drawdownCount: 0,
    longestDrawdown: 0,
  };

  if (sorted.length === 0) return empty;

  // Equity = startingCapital + cumulative realized P&L. Using equity as the
  // drawdown denominator (rather than cumulative P&L from 0) prevents the
  // pathological case where a tiny early HWM produces percentages in the
  // thousands.
  let cum = 0;
  let peakEquity = startingCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  // Track drawdown episodes: enter when equity < peakEquity, exit when equity >= peakEquity.
  let inDrawdown = false;
  let drawdownStartDate: Date | null = null;
  let drawdownWorstPct = 0;
  const drawdownDurations: number[] = []; // in days, completed episodes
  let longestDrawdown = 0;
  let drawdownCount = 0; // episodes with worst point > 5% below peakEquity

  for (const p of sorted) {
    cum += p.aggregatePnl ?? 0;
    const equity = startingCapital + cum;
    const exitDate = p.lastExitTime!;

    if (equity > peakEquity) {
      // New high water mark
      if (inDrawdown && drawdownStartDate) {
        // Recovery — record this episode
        const durationDays = (exitDate.getTime() - drawdownStartDate.getTime()) / (1000 * 60 * 60 * 24);
        drawdownDurations.push(durationDays);
        if (durationDays > longestDrawdown) longestDrawdown = durationDays;
        if (drawdownWorstPct > 5) drawdownCount++;
        inDrawdown = false;
        drawdownStartDate = null;
        drawdownWorstPct = 0;
      }
      peakEquity = equity;
    } else if (equity < peakEquity) {
      const denom = Math.max(peakEquity, 1); // guard divide-by-zero / negative peak
      const underwaterPct = Math.abs((equity - peakEquity) / denom) * 100;

      if (!inDrawdown) {
        // Start of a new drawdown episode
        inDrawdown = true;
        drawdownStartDate = exitDate;
        drawdownWorstPct = 0;
      }
      if (underwaterPct > drawdownWorstPct) drawdownWorstPct = underwaterPct;

      const underwater = equity - peakEquity; // negative dollars
      if (underwater < maxDrawdown) {
        maxDrawdown = underwater;
        maxDrawdownPercent = underwaterPct;
      }
    }
    // equity === peakEquity: no movement, stay in current state
  }

  // Current drawdown — still in a drawdown at the end of history
  const finalEquity = startingCapital + cum;
  const currentDrawdown = finalEquity < peakEquity ? finalEquity - peakEquity : 0; // ≤ 0
  const currentDrawdownDuration =
    inDrawdown && drawdownStartDate
      ? (Date.now() - drawdownStartDate.getTime()) / (1000 * 60 * 60 * 24)
      : 0;

  // If currently in drawdown and worst pct > 5%, include in count
  if (inDrawdown && drawdownWorstPct > 5) {
    drawdownCount++;
  }

  const avgDrawdownDuration =
    drawdownDurations.length > 0 ? mean(drawdownDurations) : 0;

  return {
    maxDrawdown: round2(maxDrawdown),
    maxDrawdownPercent: round2(maxDrawdownPercent),
    currentDrawdown: round2(currentDrawdown),
    currentDrawdownDuration: round2(currentDrawdownDuration),
    avgDrawdownDuration: round2(avgDrawdownDuration),
    drawdownCount,
    longestDrawdown: round2(longestDrawdown),
  };
}

// ── Fee attribution ────────────────────────────────────────────────────────────

function computeFeeAttribution(closed: Position[], totalPnl: number): FeeAttribution {
  let totalFees = 0;
  let totalFunding = 0;
  let grossWins = 0;

  for (const p of closed) {
    totalFees    += p.aggregateFees    ?? 0;
    totalFunding += p.aggregateFunding ?? 0;
    if ((p.aggregatePnl ?? 0) > 0) grossWins += p.aggregatePnl!;
  }

  // Fees are a cost to the trader. Exchange APIs often report fees as positive
  // absolute amounts — negate so totalFees is always negative (a debit).
  totalFees = -Math.abs(totalFees);

  const directionalPnl = totalPnl - totalFunding;
  const feeImpact = grossWins > 0 ? round4(Math.abs(totalFees) / grossWins * 100) : 0;
  const fundingImpact = Math.abs(totalPnl) > 0 ? round4(totalFunding / Math.abs(totalPnl) * 100) : 0;

  return {
    totalFees: round2(totalFees),
    totalFunding: round2(totalFunding),
    directionalPnl: round2(directionalPnl),
    feeImpact,
    fundingImpact,
  };
}

// ── R-multiples ────────────────────────────────────────────────────────────────

function computeRMultiples(closed: Position[]): number[] {
  const results: number[] = [];

  for (const p of closed) {
    if (p.aggregatePnl == null || p.averageEntryPrice == null) continue;

    // Prefer MAE-based risk (actual adverse excursion)
    if (p.maePrice != null && p.averageEntryPrice !== p.maePrice) {
      const risk = Math.abs(p.averageEntryPrice - p.maePrice);
      if (risk > 0) {
        results.push(p.aggregatePnl / risk);
        continue;
      }
    }

    // Fallback: invalidationPrice if stored (treated as stop)
    if (p.invalidationPrice != null && p.averageEntryPrice !== p.invalidationPrice) {
      const risk = Math.abs(p.averageEntryPrice - p.invalidationPrice);
      if (risk > 0) {
        results.push(p.aggregatePnl / risk);
      }
    }
  }

  return results;
}
