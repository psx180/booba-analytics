/**
 * xPnL — skill vs luck insight.
 *
 * Reads the per-position xPnL produced by the xpnl metric (see metrics/xpnl.ts)
 * and emits an insight describing how far the trader's actual P&L has drifted
 * from what entry features predict. Three-way bands at ±0.2 luckScore.
 *
 * Statistical backing: paired Welch t-test on actual P&L vs xPnL. A
 * significant gap in either direction means the cumulative residual is
 * unlikely to be noise.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import { computeXpnlResult } from '../metrics/xpnl';

const MIN_POSITIONS = 50;
const LUCK_BAND     = 0.2;

export const xpnlInsightDetector: InsightDetector = {
  name: 'xpnl',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['xpnl', 'aggregatePnl'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.aggregatePnl != null && p.firstEntryTime != null,
    );
    if (qualified.length < MIN_POSITIONS) return [];

    // Prefer the persisted xpnl column when present (set by the metric
    // computer in the previous run); recompute on the fly otherwise so a
    // detector run before metrics are computed still works.
    const haveStoredXpnl = qualified.every((p) => p.xpnl != null);
    const result = haveStoredXpnl
      ? buildResultFromStored(qualified)
      : computeXpnlResult(qualified);

    if (result.positions.length < MIN_POSITIONS) return [];

    const actuals = result.positions.map((r) => r.actualPnl);
    const expecteds = result.positions.map((r) => r.xpnl);
    const test = welchTTest(actuals, expecteds);

    const totalActual = actuals.reduce((s, v) => s + v, 0);
    const totalX      = expecteds.reduce((s, v) => s + v, 0);
    const gap         = totalActual - totalX;
    const luckScore   = result.luckScore;
    const luckPct     = Math.round(luckScore * 100);

    let title: string;
    let description: string;
    let severity: Insight['severity'];
    let suggestion: string | undefined;

    if (luckScore > LUCK_BAND) {
      title       = 'Skill vs Luck Analysis (xPnL)';
      description =
        `You're currently outperforming expectations by ${luckPct}%. Your actual P&L is ` +
        `$${formatSigned(gap)} above what similar trades historically produced. This ` +
        `suggests genuine skill — or a lucky streak that may revert. ` +
        `Model R²=${result.r2.toFixed(2)} on ${result.positions.length} trades.`;
      severity = 'info';
      suggestion =
        'When actual P&L runs hot relative to xPnL, the gap historically narrows. ' +
        'Resist the urge to size up — your selection edge is the same.';
    } else if (luckScore < -LUCK_BAND) {
      title       = 'Skill vs Luck Analysis (xPnL)';
      description =
        `You're underperforming expectations by ${Math.abs(luckPct)}%. Your actual P&L ` +
        `is $${formatSigned(gap)} below what similar trades historically produced. ` +
        `This may indicate bad luck rather than poor trading — your trade selection ` +
        `is reasonable but outcomes have been unfavorable. ` +
        `Model R²=${result.r2.toFixed(2)} on ${result.positions.length} trades.`;
      severity = 'info';
      suggestion =
        'Negative residuals on reasonable selections often mean revert. Avoid ' +
        'cutting size out of frustration — bad luck is not the same as bad process.';
    } else {
      title       = 'Skill vs Luck Analysis (xPnL)';
      description =
        `Your actual P&L closely matches expected P&L (luck score ${formatSigned(luckScore * 100)}%) ` +
        `— your results are consistent with your trade selection quality. ` +
        `Neither particularly lucky nor unlucky. ` +
        `Model R²=${result.r2.toFixed(2)} on ${result.positions.length} trades.`;
      severity = 'info';
    }

    const impactScore = computeImpactScore(Math.abs(gap), test, 0.4);

    return [{
      module: 'xpnl',
      title,
      description,
      suggestion,
      severity,
      confidence: sampleSizeConfidence(result.positions.length),
      affectedPositions: result.positions.map((r) => r.positionId),
      data: {
        luckScore: result.luckScore,
        luckPercent: luckPct,
        actualTotal: round(totalActual, 2),
        expectedTotal: round(totalX, 2),
        gap: round(gap, 2),
        r2: result.r2,
        tradeCount: result.positions.length,
      },
      statistics: [test],
      impactScore,
      category: 'strategy',
      isSignificant: test.isSignificant,
      sampleSize: result.positions.length,
    }];
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildResultFromStored(positions: Position[]) {
  const ordered = positions
    .filter(
      (p) =>
        p.aggregatePnl != null &&
        p.lastExitTime != null &&
        p.xpnl != null,
    )
    .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

  const rows = ordered.map((p) => ({
    positionId: p.id,
    actualPnl: p.aggregatePnl ?? 0,
    xpnl: p.xpnl ?? 0,
    residual: (p.aggregatePnl ?? 0) - (p.xpnl ?? 0),
  }));

  const cumulativeSeries: { date: string; actualCumPnl: number; xpnlCumPnl: number }[] = [];
  let actualCum = 0;
  let xCum = 0;
  for (let i = 0; i < ordered.length; i++) {
    actualCum += rows[i].actualPnl;
    xCum += rows[i].xpnl;
    cumulativeSeries.push({
      date: ordered[i].lastExitTime!.toISOString(),
      actualCumPnl: round(actualCum, 2),
      xpnlCumPnl: round(xCum, 2),
    });
  }

  const luckScore = Math.abs(xCum) > 1e-9 ? (actualCum - xCum) / Math.abs(xCum) : 0;

  // R² between actuals and stored xpnls
  const actuals = rows.map((r) => r.actualPnl);
  const expecteds = rows.map((r) => r.xpnl);
  const r2 = computeR2(actuals, expecteds);

  return {
    positions: rows,
    cumulativeSeries,
    luckScore: round(luckScore, 4),
    r2: round(r2, 4),
  };
}

function computeR2(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length);
  if (n < 2) return 0;
  const meanA = actual.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - predicted[i];
    const d = actual[i] - meanA;
    ssRes += e * e;
    ssTot += d * d;
  }
  if (ssTot < 1e-12) return 0;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

function formatSigned(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`;
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}
