/**
 * What-if equity curve computation — three counterfactual scenarios.
 *
 * Given all closed positions for a wallet/journal, computes what cumulative
 * P&L would have looked like under three alternative strategies:
 *
 *   A. Optimal exits       — exited every trade at its MFE price
 *   B. Optimal sizing      — used median position size on every trade
 *   C. No losing regime    — skipped trades in the worst-performing regime
 */

import type { PrismaClient } from '../../../generated/prisma/client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EquityPoint {
  date: string;
  balance: number;
}

export interface WhatIfCurvesResult {
  actualCurve: EquityPoint[];
  optimalExitCurve: EquityPoint[] | null;
  optimalSizingCurve: EquityPoint[] | null;
  noLosingRegimeCurve: EquityPoint[] | null;

  actualFinalPnl: number;
  optimalExitFinalPnl: number | null;
  optimalSizingFinalPnl: number | null;
  noLosingRegimeFinalPnl: number | null;

  exitMoneyLeftOnTable: number | null;   // optimalExitFinalPnl - actualFinalPnl
  sizingImprovement: number | null;      // optimalSizingFinalPnl - actualFinalPnl
  regimeFilterImprovement: number | null; // noLosingRegimeFinalPnl - actualFinalPnl

  worstRegime: string | null;
  medianSize: number | null;
  minSize: number | null;
  maxSize: number | null;
  avgExitEfficiency: number | null; // 0-1, for explanatory text

  tradeCount: number;
  mfeTradeCount: number;
}

// ── Main computation ───────────────────────────────────────────────────────────

export async function computeWhatIfCurves(
  db: PrismaClient,
  walletAddress: string,
  journalId?: string,
): Promise<WhatIfCurvesResult> {
  const where: Record<string, any> = { walletAddress, status: 'closed' };
  if (journalId) where.journalId = journalId;

  const positions = await (db as any).position.findMany({
    where,
    select: {
      id: true,
      aggregatePnl: true,
      lastExitTime: true,
      totalSize: true,
      mfePnl: true,
      regimeAtEntry: true,
    },
    orderBy: { lastExitTime: 'asc' },
  });

  // Require a valid exit time and realized P&L.
  const valid: Array<{
    id: string;
    aggregatePnl: number;
    lastExitTime: Date;
    totalSize: number | null;
    mfePnl: number | null;
    regimeAtEntry: string | null;
  }> = positions.filter(
    (p: any) => p.lastExitTime != null && p.aggregatePnl != null,
  );

  const empty: WhatIfCurvesResult = {
    actualCurve: [],
    optimalExitCurve: null,
    optimalSizingCurve: null,
    noLosingRegimeCurve: null,
    actualFinalPnl: 0,
    optimalExitFinalPnl: null,
    optimalSizingFinalPnl: null,
    noLosingRegimeFinalPnl: null,
    exitMoneyLeftOnTable: null,
    sizingImprovement: null,
    regimeFilterImprovement: null,
    worstRegime: null,
    medianSize: null,
    minSize: null,
    maxSize: null,
    avgExitEfficiency: null,
    tradeCount: 0,
    mfeTradeCount: 0,
  };

  if (valid.length === 0) return empty;

  // ── A. Actual curve ──────────────────────────────────────────────────────
  let cum = 0;
  const actualCurve: EquityPoint[] = valid.map((p) => {
    cum += p.aggregatePnl;
    return { date: p.lastExitTime.toISOString().slice(0, 10), balance: round2(cum) };
  });
  const actualFinalPnl = cum;

  // ── B. Optimal exits (MFE) ───────────────────────────────────────────────
  const mfeTradeCount = valid.filter((p) => p.mfePnl != null).length;
  let optimalExitCurve: EquityPoint[] | null = null;
  let optimalExitFinalPnl: number | null = null;

  if (mfeTradeCount >= 10) {
    cum = 0;
    optimalExitCurve = valid.map((p) => {
      cum += p.mfePnl != null ? p.mfePnl : p.aggregatePnl;
      return { date: p.lastExitTime.toISOString().slice(0, 10), balance: round2(cum) };
    });
    optimalExitFinalPnl = cum;
  }

  // ── C. Optimal sizing (fixed-fractional at median size) ──────────────────
  const validSizes = valid
    .map((p) => p.totalSize)
    .filter((s): s is number => s != null && s > 0);

  let optimalSizingCurve: EquityPoint[] | null = null;
  let optimalSizingFinalPnl: number | null = null;
  let medianSize: number | null = null;
  let minSize: number | null = null;
  let maxSize: number | null = null;

  if (validSizes.length >= 2) {
    const sorted = [...validSizes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianSize =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    minSize = sorted[0];
    maxSize = sorted[sorted.length - 1];

    cum = 0;
    optimalSizingCurve = valid.map((p) => {
      const size = p.totalSize;
      const adjusted =
        size != null && size > 0 && medianSize != null && medianSize > 0
          ? p.aggregatePnl * (medianSize / size)
          : p.aggregatePnl;
      cum += adjusted;
      return { date: p.lastExitTime.toISOString().slice(0, 10), balance: round2(cum) };
    });
    optimalSizingFinalPnl = cum;
  }

  // ── D. No losing regime ──────────────────────────────────────────────────
  let noLosingRegimeCurve: EquityPoint[] | null = null;
  let noLosingRegimeFinalPnl: number | null = null;
  let worstRegime: string | null = null;

  const hasRegimeData = valid.some((p) => p.regimeAtEntry != null);
  if (hasRegimeData) {
    const regimePnl: Record<string, number> = {};
    for (const p of valid) {
      if (p.regimeAtEntry == null) continue;
      regimePnl[p.regimeAtEntry] = (regimePnl[p.regimeAtEntry] ?? 0) + p.aggregatePnl;
    }

    let worstPnl = Infinity;
    for (const [regime, pnl] of Object.entries(regimePnl)) {
      if (pnl < worstPnl) {
        worstPnl = pnl;
        worstRegime = regime;
      }
    }

    // Only show this curve if the worst regime is actually a net loser.
    if (worstRegime != null && worstPnl < 0) {
      const filtered = valid.filter((p) => p.regimeAtEntry !== worstRegime);
      cum = 0;
      noLosingRegimeCurve = filtered.map((p) => {
        cum += p.aggregatePnl;
        return { date: p.lastExitTime.toISOString().slice(0, 10), balance: round2(cum) };
      });
      noLosingRegimeFinalPnl = cum;
    } else {
      worstRegime = null; // No regime is a net loser — don't surface the curve.
    }
  }

  // ── Exit efficiency for explanatory text ─────────────────────────────────
  let avgExitEfficiency: number | null = null;
  const mfeEff = valid
    .filter((p) => p.mfePnl != null && p.mfePnl > 0 && p.aggregatePnl > 0)
    .map((p) => Math.min(1, p.aggregatePnl / p.mfePnl!));
  if (mfeEff.length > 0) {
    avgExitEfficiency = mfeEff.reduce((s, e) => s + e, 0) / mfeEff.length;
  }

  return {
    actualCurve,
    optimalExitCurve,
    optimalSizingCurve,
    noLosingRegimeCurve,
    actualFinalPnl: round2(actualFinalPnl),
    optimalExitFinalPnl: optimalExitFinalPnl != null ? round2(optimalExitFinalPnl) : null,
    optimalSizingFinalPnl: optimalSizingFinalPnl != null ? round2(optimalSizingFinalPnl) : null,
    noLosingRegimeFinalPnl: noLosingRegimeFinalPnl != null ? round2(noLosingRegimeFinalPnl) : null,
    exitMoneyLeftOnTable:
      optimalExitFinalPnl != null ? round2(optimalExitFinalPnl - actualFinalPnl) : null,
    sizingImprovement:
      optimalSizingFinalPnl != null ? round2(optimalSizingFinalPnl - actualFinalPnl) : null,
    regimeFilterImprovement:
      noLosingRegimeFinalPnl != null ? round2(noLosingRegimeFinalPnl - actualFinalPnl) : null,
    worstRegime,
    medianSize: medianSize != null ? round2(medianSize) : null,
    minSize: minSize != null ? round2(minSize) : null,
    maxSize: maxSize != null ? round2(maxSize) : null,
    avgExitEfficiency: avgExitEfficiency != null ? Math.round(avgExitEfficiency * 10000) / 10000 : null,
    tradeCount: valid.length,
    mfeTradeCount,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
