/**
 * Walk-forward validation — does the trader's edge persist over time?
 *
 * Splits the trade history into equal-count windows and computes key
 * performance metrics per window. Trend analysis and edge-persistence checks
 * answer: "Is my strategy still working, or has my edge decayed?"
 */

import type { PrismaClient } from '../../../generated/prisma/client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WindowMetrics {
  windowStart: string;    // ISO date of first entry in window
  windowEnd: string;      // ISO date of last exit in window
  tradeCount: number;
  winRate: number;        // 0–1
  expectancy: number;     // avg P&L per trade ($)
  profitFactor: number;
  avgWin: number;         // avg P&L on winning trades ($)
  avgLoss: number;        // avg P&L on losing trades (negative $)
  totalPnl: number;
  sharpe: number;         // mean return / stddev of returns (within window)
  sortino: number;        // mean return / downside deviation (within window)
}

export interface WalkForwardResult {
  windows: WindowMetrics[];

  // Trend analysis
  winRateTrend: 'improving' | 'declining' | 'stable';
  expectancyTrend: 'improving' | 'declining' | 'stable';

  // Edge persistence
  edgePersistent: boolean;      // last windows show similar/better vs early windows
  degradationDetected: boolean; // recent performance significantly worse

  // Specific insights
  bestWindow:  { index: number; label: string; expectancy: number };
  worstWindow: { index: number; label: string; expectancy: number };

  // Regression stats (per-window change)
  winRateSlope: number;
  expectancySlope: number;

  // First-N / last-N slice averages used to decide degradation / persistence /
  // the summary paragraph. Exposed so the frontend renders headline copy from
  // the same numbers the paragraph does, instead of re-deriving from
  // windows[0] / windows[last] and ending up with a different split.
  firstAvg: number;
  lastAvg: number;

  summary: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function windowCountFor(tradeCount: number): number | null {
  if (tradeCount < 30)  return null;
  if (tradeCount < 60)  return 3;
  if (tradeCount < 120) return 4;
  if (tradeCount < 200) return 5;
  return 6;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function windowLabel(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const startMon = MONTHS[s.getUTCMonth()];
  const endMon   = MONTHS[e.getUTCMonth()];
  const year     = String(e.getUTCFullYear()).slice(2);
  if (startMon === endMon) return `${startMon} '${year}`;
  return `${startMon}-${endMon} '${year}`;
}

/** Ordinary least-squares slope for y = a + b*x where x = [0, 1, …, n-1]. */
function linearSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const sumX  = (n * (n - 1)) / 2;               // 0 + 1 + … + (n-1)
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6; // sum of i²
  const sumY  = ys.reduce((a, v) => a + v, 0);
  const sumXY = ys.reduce((a, v, i) => a + i * v, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function stddev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

/** Mean of absolute values — used for scaling the expectancy trend threshold. */
function meanAbs(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + Math.abs(v), 0) / values.length;
}

function downsideDeviation(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const downside = values.map((v) => Math.min(v, 0));
  const variance = downside.reduce((a, v) => a + v ** 2, 0) / n;
  return Math.sqrt(variance);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function computeWindowMetrics(
  pnls: number[],
  startIso: string,
  endIso: string,
): WindowMetrics {
  const wins   = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);

  const winRate      = pnls.length > 0 ? wins.length / pnls.length : 0;
  const expectancy   = pnls.length > 0 ? pnls.reduce((a, v) => a + v, 0) / pnls.length : 0;
  const avgWin       = wins.length   > 0 ? wins.reduce((a, v)   => a + v, 0) / wins.length   : 0;
  const avgLoss      = losses.length > 0 ? losses.reduce((a, v) => a + v, 0) / losses.length : 0;
  const totalPnl     = pnls.reduce((a, v) => a + v, 0);

  const grossWins   = wins.reduce((a, v) => a + v, 0);
  const grossLosses = Math.abs(losses.reduce((a, v) => a + v, 0));
  const profitFactor =
    grossLosses > 0 ? grossWins / grossLosses :
    grossWins   > 0 ? 99.99 : 0;

  const sd     = stddev(pnls);
  const sharpe = sd > 0 ? expectancy / sd : 0;

  const dd      = downsideDeviation(pnls);
  const sortino = dd > 0 ? expectancy / dd : 0;

  return {
    windowStart:  startIso,
    windowEnd:    endIso,
    tradeCount:   pnls.length,
    winRate:      r2(winRate),
    expectancy:   r2(expectancy),
    profitFactor: r2(profitFactor),
    avgWin:       r2(avgWin),
    avgLoss:      r2(avgLoss),
    totalPnl:     r2(totalPnl),
    sharpe:       r2(sharpe),
    sortino:      r2(sortino),
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function computeWalkForward(
  db: PrismaClient,
  walletAddress: string,
  journalId?: string,
): Promise<WalkForwardResult | null> {
  const where: Record<string, any> = {
    walletAddress,
    status: 'closed',
    lastExitTime: { not: null },
  };
  if (journalId) where.journalId = journalId;

  const rows = await (db as any).position.findMany({
    where,
    select: {
      aggregatePnl:   true,
      firstEntryTime: true,
      lastExitTime:   true,
    },
    orderBy: { lastExitTime: 'asc' },
  });

  // Filter residual nulls and normalise
  const trades: { pnl: number; start: string; end: string }[] = rows
    .filter((p: any) => p.lastExitTime != null)
    .map((p: any) => ({
      pnl:   p.aggregatePnl ?? 0,
      start: (p.firstEntryTime ?? p.lastExitTime).toISOString(),
      end:   p.lastExitTime.toISOString(),
    }));

  const numWindows = windowCountFor(trades.length);
  if (numWindows === null) return null;

  // ── Build equal-count windows ─────────────────────────────────────────────

  const baseSize  = Math.floor(trades.length / numWindows);
  const remainder = trades.length % numWindows;
  const windows: WindowMetrics[] = [];
  let cursor = 0;

  for (let i = 0; i < numWindows; i++) {
    // Distribute remainder trades into the first few windows so no window is
    // shorter than expected (avoids a tiny last window that skews the stats).
    const size  = baseSize + (i < remainder ? 1 : 0);
    const slice = trades.slice(cursor, cursor + size);
    cursor += size;

    windows.push(computeWindowMetrics(
      slice.map((t) => t.pnl),
      slice[0].start,
      slice[slice.length - 1].end,
    ));
  }

  // ── Trend analysis ────────────────────────────────────────────────────────
  // Thresholds are kept in their native units: the expectancy threshold
  // scales with the typical window expectancy so a $50-per-trade account and
  // a $0.50-per-trade account don't share a trivially-crossed $0.02 floor,
  // while win-rate (a 0–1 fraction) gets a fraction-scale threshold tied to
  // its own variance so stable win rates don't flip between labels on noise.

  const winRates       = windows.map((w) => w.winRate);
  const expectancies   = windows.map((w) => w.expectancy);
  const winRateSlope    = linearSlope(winRates);
  const expectancySlope = linearSlope(expectancies);

  const meanAbsExpectancy = meanAbs(expectancies);
  const expectancyThreshold = Math.max(0.02, meanAbsExpectancy * 0.1);

  const winRateStd = stddev(winRates);
  const winRateThreshold = Math.max(0.01, winRateStd * 0.3);

  const winRateTrend: WalkForwardResult['winRateTrend'] =
    winRateSlope >  winRateThreshold ? 'improving'
      : winRateSlope < -winRateThreshold ? 'declining'
      : 'stable';
  const expectancyTrend: WalkForwardResult['expectancyTrend'] =
    expectancySlope >  expectancyThreshold ? 'improving'
      : expectancySlope < -expectancyThreshold ? 'declining'
      : 'stable';

  // ── Edge persistence ──────────────────────────────────────────────────────

  // Compare last N windows vs first N windows (N = 2 when ≥4 windows, else 1).
  // The persistence / degradation checks below previously used a signed
  // ratio against firstAvg, which inverts when firstAvg is negative (a
  // losing trader getting worse still looked "persistent"). The new
  // conditions anchor on absolute sign: degradation fires only when the
  // account has drifted below zero, and persistence requires the edge to
  // stay positive.
  const compareN  = numWindows >= 4 ? 2 : 1;
  const firstSlice = windows.slice(0, compareN);
  const lastSlice  = windows.slice(-compareN);
  const firstAvg   = firstSlice.reduce((a, w) => a + w.expectancy, 0) / compareN;
  const lastAvg    = lastSlice.reduce((a, w)  => a + w.expectancy, 0) / compareN;

  const degradationDetected = lastAvg < firstAvg && lastAvg < 0;
  const edgePersistent      = lastAvg > 0 && firstAvg > 0 && lastAvg > firstAvg * 0.8;

  // ── Best / worst windows ──────────────────────────────────────────────────

  let bestIdx  = 0;
  let worstIdx = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].expectancy > windows[bestIdx].expectancy)  bestIdx  = i;
    if (windows[i].expectancy < windows[worstIdx].expectancy) worstIdx = i;
  }

  const bestLabel  = windowLabel(windows[bestIdx].windowStart,  windows[bestIdx].windowEnd);
  const worstLabel = windowLabel(windows[worstIdx].windowStart, windows[worstIdx].windowEnd);

  // ── Summary ───────────────────────────────────────────────────────────────

  let summary: string;
  if (degradationDetected) {
    summary =
      `Your strategy performance has declined. Windows 1–${compareN} averaged ` +
      `$${r2(firstAvg)} expectancy, but windows ${numWindows - compareN + 1}–${numWindows} ` +
      `averaged $${r2(lastAvg)}. Your edge may be eroding — consider reviewing your approach.`;
  } else if (expectancyTrend === 'improving' && lastAvg > 0) {
    const improvePct =
      firstAvg !== 0
        ? Math.round(((lastAvg - firstAvg) / Math.abs(firstAvg)) * 100)
        : null;
    const improveStr = improvePct != null ? `${improvePct}%` : 'significantly';
    summary =
      `Your performance is improving. Recent trades show ${improveStr} higher expectancy ` +
      `than your early trades. Your skills are developing.`;
  } else if (expectancyTrend === 'improving' && lastAvg <= 0) {
    // Still unprofitable, but losses are shrinking — don't celebrate the
    // slope while every window is still negative. Frames the trajectory
    // honestly: direction is right, result isn't there yet.
    summary =
      `Your losses are decreasing — expectancy improved from $${r2(firstAvg)} to ` +
      `$${r2(lastAvg)} per trade, but remains negative. Continued improvement ` +
      `needed to reach profitability.`;
  } else {
    summary =
      `Your performance is consistent across time periods. Your edge appears durable.`;
  }

  return {
    windows,
    winRateTrend,
    expectancyTrend,
    edgePersistent,
    degradationDetected,
    bestWindow:  { index: bestIdx,  label: bestLabel,  expectancy: windows[bestIdx].expectancy  },
    worstWindow: { index: worstIdx, label: worstLabel, expectancy: windows[worstIdx].expectancy },
    winRateSlope:    r2(winRateSlope),
    expectancySlope: r2(expectancySlope),
    firstAvg: r2(firstAvg),
    lastAvg:  r2(lastAvg),
    summary,
  };
}
