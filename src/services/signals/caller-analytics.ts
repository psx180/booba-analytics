/**
 * caller-analytics.ts — Compute trading analytics on a caller's signal history.
 *
 * Converts a caller's resolved signals into synthetic positions (normalized to
 * equal size, PnL expressed as %) then runs simplified analytics inline —
 * win rate, expectancy, profit factor, equity curve, regime/asset breakdown,
 * simplified Elo, 4-axis WART-style scores, and streaks.
 *
 * The full AnalyticsService is not imported here — it's tightly coupled to
 * real Position records and DB writes. Everything here is a straightforward
 * aggregation over the in-memory signal array.
 */

import { prisma } from '../../lib/prisma';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyntheticPosition {
  id: string;
  asset: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  /** Percentage P&L (e.g. 2.5 = +2.5%). Normalized: totalSize = 1.0. */
  pnlRealized: number;
  totalSize: number;
  entryTime: Date;
  exitTime: Date;
  regime: string | null;
  tradeType: string;
}

export interface CallerAnalytics {
  callerName: string;
  totalSignals: number;

  // Basic stats (pnl values in %)
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number;

  // WART-style axes (0-100 each)
  entryScore: number;
  exitScore: number;
  riskScore: number;
  timingScore: number;

  // Elo
  eloRating: number;
  eloTier: string;

  // Breakdowns
  regimeBreakdown: { regime: string; winRate: number; avgPnl: number; count: number }[];
  assetBreakdown: { asset: string; winRate: number; avgPnl: number; count: number }[];

  // Equity curve (cumulative % P&L)
  equityCurve: { date: string; balance: number }[];

  // Streaks
  longestWinStreak: number;
  longestLoseStreak: number;
  currentStreak: { type: 'win' | 'loss'; count: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tierFor(elo: number): string {
  if (elo < 1200) return 'Beginner';
  if (elo < 1400) return 'Intermediate';
  if (elo < 1600) return 'Advanced';
  if (elo < 1800) return 'Expert';
  return 'Grandmaster';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(v: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function computeCallerAnalytics(
  walletAddress: string,
  callerName: string,
): Promise<CallerAnalytics | null> {
  // ── 1. Load resolved signals ──────────────────────────────────────────────
  const signals = await prisma.signal.findMany({
    where: { walletAddress, callerName, status: { not: 'open' } },
    orderBy: { createdAt: 'asc' },
  });

  if (signals.length < 5) return null;

  // ── 2. Batch-lookup BTC regime snapshots for the signal date range ────────
  const minDate = signals[0].createdAt;
  const maxDate = signals[signals.length - 1].createdAt;
  // Extend the upper bound a week forward to catch the last snapshot.
  const extendedMax = new Date(maxDate.getTime() + 7 * 86_400_000);

  const regimeSnapshots = await prisma.regimeSnapshot.findMany({
    where: { asset: 'BTC', timestamp: { gte: minDate, lte: extendedMax } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, regimeClassification: true },
  });

  function findRegime(date: Date): string | null {
    if (regimeSnapshots.length === 0) return null;
    // Latest snapshot whose timestamp is <= the signal's createdAt.
    let best: string | null = null;
    for (const snap of regimeSnapshots) {
      if (snap.timestamp <= date) best = snap.regimeClassification;
      else break;
    }
    return best;
  }

  // ── 3. Build synthetic positions ──────────────────────────────────────────
  const positions: SyntheticPosition[] = [];

  for (const sig of signals) {
    if (!sig.resolvedAt) continue;

    // Determine exit price
    const exitPrice =
      sig.outcomePrice ??
      (sig.status === 'hit_target' && sig.targetPrice != null ? sig.targetPrice : null) ??
      (sig.status === 'hit_stop' && sig.stopPrice != null ? sig.stopPrice : null);
    if (exitPrice == null) continue;

    // PnL as percentage (use stored value when available; recompute as fallback)
    let pnlRealized: number;
    if (sig.outcomePnlPct != null) {
      pnlRealized = sig.outcomePnlPct;
    } else {
      pnlRealized =
        sig.direction === 'LONG'
          ? ((exitPrice - sig.entryPrice) / sig.entryPrice) * 100
          : ((sig.entryPrice - exitPrice) / sig.entryPrice) * 100;
    }

    positions.push({
      id: sig.id,
      asset: sig.asset,
      direction: sig.direction,
      entryPrice: sig.entryPrice,
      exitPrice,
      pnlRealized,
      totalSize: 1.0,
      entryTime: sig.createdAt,
      exitTime: sig.resolvedAt,
      regime: findRegime(sig.createdAt),
      tradeType: 'directional',
    });
  }

  if (positions.length < 5) return null;

  // ── 4. Sort chronologically by exit time ──────────────────────────────────
  const sorted = [...positions].sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime());

  // ── 5. Basic stats ────────────────────────────────────────────────────────
  const winners = positions.filter((p) => p.pnlRealized > 0);
  const losers = positions.filter((p) => p.pnlRealized < 0);
  const n = positions.length;

  const winRate = round(winners.length / n, 4);
  const avgWin = round(avg(winners.map((p) => p.pnlRealized)), 2);
  const avgLoss = round(avg(losers.map((p) => p.pnlRealized)), 2);
  const expectancy = round(avg(positions.map((p) => p.pnlRealized)), 2);
  const grossWins = winners.reduce((s, p) => s + p.pnlRealized, 0);
  const grossLosses = losers.reduce((s, p) => s + Math.abs(p.pnlRealized), 0);
  const profitFactor = round(
    grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0,
    2,
  );

  // ── 6. Equity curve (cumulative % P&L sorted by exit time) ───────────────
  let balance = 0;
  const equityCurve = sorted.map((p) => {
    balance += p.pnlRealized;
    return { date: p.exitTime.toISOString(), balance: round(balance, 2) };
  });

  // ── 7. Regime breakdown ───────────────────────────────────────────────────
  const byRegime = new Map<string, SyntheticPosition[]>();
  for (const p of positions) {
    const r = p.regime ?? 'unknown';
    const arr = byRegime.get(r) ?? [];
    arr.push(p);
    byRegime.set(r, arr);
  }
  const regimeBreakdown = [...byRegime.entries()].map(([regime, ps]) => ({
    regime,
    winRate: round(ps.filter((p) => p.pnlRealized > 0).length / ps.length, 4),
    avgPnl: round(avg(ps.map((p) => p.pnlRealized)), 2),
    count: ps.length,
  }));

  // ── 8. Asset breakdown ────────────────────────────────────────────────────
  const byAsset = new Map<string, SyntheticPosition[]>();
  for (const p of positions) {
    const arr = byAsset.get(p.asset) ?? [];
    arr.push(p);
    byAsset.set(p.asset, arr);
  }
  const assetBreakdown = [...byAsset.entries()].map(([asset, ps]) => ({
    asset,
    winRate: round(ps.filter((p) => p.pnlRealized > 0).length / ps.length, 4),
    avgPnl: round(avg(ps.map((p) => p.pnlRealized)), 2),
    count: ps.length,
  }));

  // ── 9. Elo (simplified) ───────────────────────────────────────────────────
  // Start at 1200, K=32, neutral opponent always at expected 0.5.
  const K_ELO = 32;
  let eloRating = 1200;
  for (const p of sorted) {
    const score = p.pnlRealized > 0 ? 1 : p.pnlRealized < 0 ? 0 : 0.5;
    eloRating += K_ELO * (score - 0.5);
  }
  eloRating = round(eloRating, 1);
  const eloTier = tierFor(eloRating);

  // ── 10. WART-style axes (simplified 4-axis) ───────────────────────────────

  // Entry: signal accuracy — how often the entry-to-target move happened
  const signalsWithTarget = signals.filter((s) => s.targetPrice != null);
  const entryScore = signalsWithTarget.length > 0
    ? clamp(
        (signalsWithTarget.filter((s) => s.status === 'hit_target').length / signalsWithTarget.length) * 100,
        0, 100,
      )
    : clamp(winRate * 100, 0, 100); // fallback: raw win rate

  // Exit: average R-multiple achieved (2R = score 100)
  const signalsWithR = signals.filter((s) => s.outcomeRMultiple != null);
  const avgRMultiple = signalsWithR.length > 0
    ? avg(signalsWithR.map((s) => s.outcomeRMultiple!))
    : null;
  const exitScore = avgRMultiple != null ? clamp(avgRMultiple * 50, 0, 100) : 50;

  // Risk: stops not getting hit (lower stop-hit rate = better risk management)
  const signalsWithStop = signals.filter((s) => s.stopPrice != null);
  const stopHitRate = signalsWithStop.length > 0
    ? signalsWithStop.filter((s) => s.status === 'hit_stop').length / signalsWithStop.length
    : 0;
  const riskScore = clamp((1 - stopHitRate) * 100, 0, 100);

  // Timing: average win rate across regimes (rewards multi-regime consistency)
  const regimeWinRates = regimeBreakdown.map((r) => r.winRate);
  const timingScore = regimeWinRates.length > 0
    ? clamp(avg(regimeWinRates) * 100, 0, 100)
    : 50;

  // ── 11. Streaks ───────────────────────────────────────────────────────────
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  let curWin = 0;
  let curLoss = 0;

  for (const p of sorted) {
    if (p.pnlRealized > 0) {
      curWin++;
      curLoss = 0;
      longestWinStreak = Math.max(longestWinStreak, curWin);
    } else {
      curLoss++;
      curWin = 0;
      longestLoseStreak = Math.max(longestLoseStreak, curLoss);
    }
  }

  // Current streak: count consecutive same-outcome trades from the end
  let currentStreak: { type: 'win' | 'loss'; count: number } = { type: 'win', count: 0 };
  if (sorted.length > 0) {
    const lastIsWin = sorted[sorted.length - 1].pnlRealized > 0;
    let count = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const isWin = sorted[i].pnlRealized > 0;
      if (isWin === lastIsWin) count++;
      else break;
    }
    currentStreak = { type: lastIsWin ? 'win' : 'loss', count };
  }

  return {
    callerName,
    totalSignals: signals.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    entryScore: round(entryScore, 1),
    exitScore: round(exitScore, 1),
    riskScore: round(riskScore, 1),
    timingScore: round(timingScore, 1),
    eloRating,
    eloTier,
    regimeBreakdown,
    assetBreakdown,
    equityCurve,
    longestWinStreak,
    longestLoseStreak,
    currentStreak,
  };
}
