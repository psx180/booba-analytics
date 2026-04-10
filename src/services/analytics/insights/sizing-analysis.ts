/**
 * Sizing analysis insight.
 *
 * Three-angle analysis of position sizing behaviour:
 *   1. Consistency — coefficient of variation + correlation of size with P&L
 *   2. Half-Kelly reference — what optimal fractional sizing suggests
 *   3. Regime-adjusted sizing — high-vol vs low-vol size and loss comparison
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, pearsonCorrelation, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 30;

export const sizingAnalysisDetector: InsightDetector = {
  name: 'sizing-analysis',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['totalSize', 'aggregatePnl', 'regimeAtEntry', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) =>
        p.totalSize != null &&
        p.totalSize > 0 &&
        p.aggregatePnl != null &&
        p.firstEntryTime != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      return [{
        module: 'sizing-analysis',
        title: 'Sizing Analysis Pending',
        description: `Need ${MIN_POSITIONS - qualified.length} more trades with size data to analyse position sizing behaviour.`,
        severity: 'info',
        confidence: 0,
        affectedPositions: [],
        data: { tradeCount: qualified.length, needed: MIN_POSITIONS - qualified.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0,
        category: 'risk',
        isSignificant: false,
        sampleSize: qualified.length,
      }];
    }

    // ── Angle 1: Sizing consistency ─────────────────────────────────────────

    const sizes = qualified.map((p) => p.totalSize!);
    const pnls  = qualified.map((p) => p.aggregatePnl!);

    const avgSize = mean(sizes);
    const stdSize = sampleStddev(sizes);
    const cv      = avgSize > 0 ? stdSize / avgSize : 0;

    const rawR          = rawPearsonR(sizes, pnls);
    const sizeVsPnlTest = pearsonCorrelation(sizes, pnls);

    // After-win vs after-loss sizing
    const sortedByTime = [...qualified].sort(
      (a, b) =>
        new Date(a.firstEntryTime!).getTime() - new Date(b.firstEntryTime!).getTime(),
    );
    const afterWinSizes: number[]  = [];
    const afterLossSizes: number[] = [];
    for (let i = 1; i < sortedByTime.length; i++) {
      const prevPnl = sortedByTime[i - 1].aggregatePnl ?? 0;
      if (prevPnl > 0)      afterWinSizes.push(sortedByTime[i].totalSize!);
      else if (prevPnl < 0) afterLossSizes.push(sortedByTime[i].totalSize!);
    }
    const avgAfterWin  = afterWinSizes.length  > 0 ? mean(afterWinSizes)  : avgSize;
    const avgAfterLoss = afterLossSizes.length > 0 ? mean(afterLossSizes) : avgSize;

    // ── Angle 2: Half-Kelly reference ────────────────────────────────────────

    const winPositions  = qualified.filter((p) => (p.aggregatePnl ?? 0) > 0);
    const lossPositions = qualified.filter((p) => (p.aggregatePnl ?? 0) < 0);
    const winRate       = winPositions.length / qualified.length;
    const avgWin        = winPositions.length  > 0 ? mean(winPositions.map((p) => p.aggregatePnl!))              : 0;
    const avgLossAbs    = lossPositions.length > 0 ? mean(lossPositions.map((p) => Math.abs(p.aggregatePnl!)))   : 0;

    let halfKelly = 0;
    let kellyLine = 'Insufficient win/loss history to compute Kelly reference.';
    if (avgLossAbs > 0 && avgWin > 0 && winRate > 0 && winRate < 1) {
      const b       = avgWin / avgLossAbs;                       // win/loss odds ratio
      const kellyF  = (winRate * b - (1 - winRate)) / b;        // standard Kelly fraction
      halfKelly     = Math.max(0, kellyF / 2);
      kellyLine     = halfKelly > 0
        ? `Half-Kelly reference: ${(halfKelly * 100).toFixed(1)}% of account per trade ` +
          `(win rate ${(winRate * 100).toFixed(0)}%, avg win $${avgWin.toFixed(2)}, avg loss $${avgLossAbs.toFixed(2)}). ` +
          `Note: Kelly sizing assumes historical statistics will persist. Use as a reference point, not a prescription.`
        : `Negative Kelly fraction — your edge may not support current sizing levels ` +
          `(win rate ${(winRate * 100).toFixed(0)}%, avg win $${avgWin.toFixed(2)}, avg loss $${avgLossAbs.toFixed(2)}).`;
    }

    // ── Angle 3: Regime-adjusted sizing ──────────────────────────────────────

    const highVolPositions = qualified.filter((p) => p.regimeAtEntry?.includes('high_vol'));
    const lowVolPositions  = qualified.filter((p) => p.regimeAtEntry?.includes('low_vol'));

    let regimeSizeTest: StatisticalTest | null = null;
    let regimeLossTest: StatisticalTest | null = null;
    let avgSizeHighVol      = 0;
    let avgSizeLowVol       = 0;
    let avgLossHighVol      = 0;
    let avgLossLowVol       = 0;
    let regimeDollarSavings = 0;

    if (highVolPositions.length >= 5 && lowVolPositions.length >= 5) {
      const hvSizes = highVolPositions.map((p) => p.totalSize!);
      const lvSizes = lowVolPositions.map((p) => p.totalSize!);
      avgSizeHighVol = mean(hvSizes);
      avgSizeLowVol  = mean(lvSizes);
      regimeSizeTest = welchTTest(hvSizes, lvSizes);

      const hvLossAmts = highVolPositions
        .filter((p) => (p.aggregatePnl ?? 0) < 0)
        .map((p) => Math.abs(p.aggregatePnl!));
      const lvLossAmts = lowVolPositions
        .filter((p) => (p.aggregatePnl ?? 0) < 0)
        .map((p) => Math.abs(p.aggregatePnl!));

      avgLossHighVol = hvLossAmts.length > 0 ? mean(hvLossAmts) : 0;
      avgLossLowVol  = lvLossAmts.length > 0 ? mean(lvLossAmts) : 0;

      if (hvLossAmts.length >= 3 && lvLossAmts.length >= 3) {
        regimeLossTest = welchTTest(hvLossAmts, lvLossAmts);

        // Dollar savings from matching high-vol position size to low-vol average
        if (avgSizeHighVol > avgSizeLowVol && avgLossHighVol > 0) {
          const reductionFactor   = avgSizeLowVol / avgSizeHighVol;
          const excessLossPerTrade = avgLossHighVol * (1 - reductionFactor);
          regimeDollarSavings     = excessLossPerTrade * hvLossAmts.length;
        }
      }
    }

    // ── Describe each angle ───────────────────────────────────────────────────

    const cvLabel =
      cv < 0.3 ? `consistent (CV=${cv.toFixed(2)})` :
      cv < 0.7 ? `moderately variable (CV=${cv.toFixed(2)})` :
                 `highly variable (CV=${cv.toFixed(2)}, likely discretionary)`;

    const corrLine =
      sizeVsPnlTest.isSignificant && rawR < -0.1
        ? `Larger positions correlate with worse outcomes (r=${rawR.toFixed(2)}, ${sizeVsPnlTest.description}).`
        : sizeVsPnlTest.isSignificant && rawR > 0.1
          ? `Larger positions tend to perform better (r=${rawR.toFixed(2)}) — positive sign.`
          : `No significant relationship between position size and outcome (r=${rawR.toFixed(2)}).`;

    const afterLine =
      afterWinSizes.length > 2 && afterLossSizes.length > 2
        ? ` Average size after a win: ${avgAfterWin.toFixed(4)}, after a loss: ${avgAfterLoss.toFixed(4)}.`
        : '';

    const angle1 = `Sizing consistency: ${cvLabel}. ${corrLine}${afterLine}`;

    const angle2 = `Kelly reference: ${kellyLine}`;

    let angle3: string;
    if (regimeSizeTest == null) {
      angle3 = 'Regime sizing: insufficient high-vol / low-vol data for comparison (need 5+ trades per regime).';
    } else {
      const sizeDirection =
        avgSizeHighVol > avgSizeLowVol
          ? `${((avgSizeHighVol / avgSizeLowVol - 1) * 100).toFixed(0)}% larger`
          : `${((1 - avgSizeHighVol / avgSizeLowVol) * 100).toFixed(0)}% smaller`;
      angle3 =
        `Regime sizing: average position is ${sizeDirection} in high-vol regimes ` +
        `(${avgSizeHighVol.toFixed(4)} vs ${avgSizeLowVol.toFixed(4)} in low-vol). `;
      if (avgLossHighVol > 0 && avgLossLowVol > 0 && avgSizeHighVol >= avgSizeLowVol * 0.95) {
        angle3 +=
          `Average loss in high-vol: $${avgLossHighVol.toFixed(2)} vs $${avgLossLowVol.toFixed(2)} in low-vol. `;
        if (regimeDollarSavings > 0) {
          angle3 +=
            `Reducing high-vol size to match low-vol would have saved ~$${Math.round(regimeDollarSavings).toLocaleString()}.`;
        }
      }
    }

    // ── Determine verdict and primary statistic ──────────────────────────────

    const hasNegativeCorr    = sizeVsPnlTest.isSignificant && rawR < -0.1;
    const isHighVolNotSmaller = avgSizeHighVol > 0 && avgSizeLowVol > 0 && avgSizeHighVol >= avgSizeLowVol * 0.95;
    const isHighVolSizeLarger = regimeSizeTest?.isSignificant === true && avgSizeHighVol > avgSizeLowVol;
    const isHighlyVariable    = cv > 0.7;

    const isWarning = hasNegativeCorr || isHighVolSizeLarger || isHighlyVariable;

    // Pick the test and dollar impact for the most actionable finding
    let primaryTest: StatisticalTest;
    let dollarImpact: number;

    if (regimeDollarSavings > 0 && (regimeLossTest != null || regimeSizeTest != null)) {
      primaryTest  = regimeLossTest ?? regimeSizeTest!;
      dollarImpact = regimeDollarSavings;
    } else if (hasNegativeCorr) {
      primaryTest  = sizeVsPnlTest;
      // Rough dollar cost: excess losses on above-average-size trades
      const oversizedLosses = qualified.filter(
        (p) => p.totalSize! > avgSize && (p.aggregatePnl ?? 0) < 0,
      );
      dollarImpact = oversizedLosses.reduce((s, p) => s + Math.abs(p.aggregatePnl!), 0);
    } else {
      primaryTest  = sizeVsPnlTest;
      dollarImpact = 0;
    }

    // Collect unique statistics (primary first)
    const statsSet: StatisticalTest[] = [primaryTest];
    for (const t of [regimeSizeTest, regimeLossTest, sizeVsPnlTest]) {
      if (t != null && !statsSet.includes(t)) statsSet.push(t);
    }

    const isSignificant = statsSet.some((t) => t.isSignificant);
    const confidence    = sampleSizeConfidence(qualified.length);
    const impactScore   = computeImpactScore(Math.max(dollarImpact, 1), primaryTest, 0.7);

    // ── Positive path ────────────────────────────────────────────────────────

    if (!isWarning) {
      return [{
        module: 'sizing-analysis',
        title: 'Disciplined Position Sizing',
        description: `${angle1} ${angle2} ${angle3}`.trim(),
        severity: 'info',
        confidence,
        affectedPositions: [],
        data: {
          cv:             round4(cv),
          correlationR:   round4(rawR),
          halfKelly:      round4(halfKelly),
          avgSizeHighVol: avgSizeHighVol > 0 ? round4(avgSizeHighVol) : null,
          avgSizeLowVol:  avgSizeLowVol  > 0 ? round4(avgSizeLowVol)  : null,
          avgAfterWin:    round4(avgAfterWin),
          avgAfterLoss:   round4(avgAfterLoss),
          tradeCount:     qualified.length,
        },
        statistics: statsSet,
        impactScore: 0,
        category: 'risk',
        isSignificant,
        sampleSize: qualified.length,
      }];
    }

    // ── Warning path ──────────────────────────────────────────────────────────

    let suggestion: string | undefined;
    if (hasNegativeCorr && isHighVolNotSmaller) {
      suggestion =
        'Your larger trades tend to lose more AND you are not reducing size in volatile markets. ' +
        'Consider fixed fractional sizing and explicitly reducing position size by 20–30% in high-volatility regimes.';
    } else if (hasNegativeCorr) {
      suggestion =
        'Your larger trades tend to underperform. Moving to fixed fractional sizing (or capping position size) ' +
        'could remove this negative size-bias from your outcomes.';
    } else if (isHighVolSizeLarger) {
      const savingsStr =
        regimeDollarSavings > 0
          ? ` This would have saved ~$${Math.round(regimeDollarSavings).toLocaleString()}.`
          : '';
      suggestion = `Smart traders reduce size in volatile conditions. Scaling down to low-vol average sizing during high-vol regimes could improve your risk-adjusted returns.${savingsStr}`;
    } else if (isHighlyVariable) {
      suggestion =
        'Highly variable sizing suggests discretionary or emotional position sizing. ' +
        'Consider a systematic rule — e.g. fixed fractional or Kelly-based — to remove ad-hoc size decisions.';
    }

    return [{
      module: 'sizing-analysis',
      title: 'Position Sizing Issues Detected',
      description: `${angle1} ${angle2} ${angle3}`.trim(),
      suggestion,
      severity: dollarImpact > 500 ? 'warning' : 'info',
      confidence,
      affectedPositions: [],
      data: {
        cv:                    round4(cv),
        correlationR:          round4(rawR),
        halfKelly:             round4(halfKelly),
        avgSizeHighVol:        avgSizeHighVol > 0 ? round4(avgSizeHighVol) : null,
        avgSizeLowVol:         avgSizeLowVol  > 0 ? round4(avgSizeLowVol)  : null,
        regimeDollarSavings:   Math.round(regimeDollarSavings * 100) / 100,
        avgAfterWin:           round4(avgAfterWin),
        avgAfterLoss:          round4(avgAfterLoss),
        dollarImpact:          Math.round(dollarImpact * 100) / 100,
        tradeCount:            qualified.length,
      },
      statistics: statsSet,
      impactScore,
      category: 'risk',
      isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m        = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Signed Pearson r — statistics.ts returns |r| only. */
function rawPearsonR(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom < 1e-12 ? 0 : num / denom;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function pending(testName: string, n: number): StatisticalTest {
  return {
    testName,
    pValue: 1,
    effectSize: 0,
    sampleSizeA: n,
    sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
