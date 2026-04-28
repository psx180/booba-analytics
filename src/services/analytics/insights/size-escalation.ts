/**
 * Size-escalation insight.
 *
 * Hypothesis: position size increases after losses (martingale-like behaviour).
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 30;

export const sizeEscalationDetector: InsightDetector = {
  name: 'size-escalation',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['totalSize', 'aggregatePnl', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.firstEntryTime != null && p.totalSize != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'size-escalation',
        title: 'Position Sizing Analysis Pending',
        description: `Need ${needed} more trades with size data. Watching whether position sizes increase after losses.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Sort by entry time; classify each trade by the previous trade's outcome
    const sorted = [...qualified].sort(
      (a, b) => new Date(a.firstEntryTime!).getTime() - new Date(b.firstEntryTime!).getTime(),
    );

    const afterLoss: Position[] = [];
    const afterWin: Position[]  = [];

    for (let i = 1; i < sorted.length; i++) {
      const prevPnl = sorted[i - 1].aggregatePnl ?? 0;
      if (prevPnl < 0)      afterLoss.push(sorted[i]);
      else if (prevPnl > 0) afterWin.push(sorted[i]);
    }

    if (afterLoss.length < 2 || afterWin.length < 2) {
      return [{
        module: 'size-escalation',
        title: 'Position Sizing Analysis Pending',
        description: 'Not enough alternating wins/losses yet to test size escalation.',
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { afterLossCount: afterLoss.length, afterWinCount: afterWin.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    const lossSizes = afterLoss.map((p) => p.totalSize!);
    const winSizes  = afterWin.map((p) => p.totalSize!);
    const sizeTest  = welchTTest(lossSizes, winSizes);

    const avgAfterLoss = mean(lossSizes);
    const avgAfterWin  = mean(winSizes);
    const sizeDiffPct  = avgAfterWin > 0
      ? Math.round(((avgAfterLoss / avgAfterWin) - 1) * 100)
      : 0;

    // Check whether oversized post-loss entries have worse outcomes
    const overallAvgSize = mean(qualified.map((p) => p.totalSize!));
    const bigPostLoss    = afterLoss.filter((p) => p.totalSize! > overallAvgSize);
    const normPostLoss   = afterLoss.filter((p) => p.totalSize! <= overallAvgSize);

    const outcomeTest = bigPostLoss.length >= 2 && normPostLoss.length >= 2
      ? welchTTest(bigPostLoss.map((p) => p.aggregatePnl!), normPostLoss.map((p) => p.aggregatePnl!))
      : null;

    const afterLossWins   = afterLoss.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const overallWins     = qualified.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const afterLossWinRate = Math.round((afterLossWins / afterLoss.length) * 100);
    const overallWinRate   = Math.round((overallWins / qualified.length) * 100);

    // Dollar impact approximation: excess size × loss rate
    const excessSize   = Math.max(0, avgAfterLoss - avgAfterWin);
    const lossRate     = 1 - afterLossWins / afterLoss.length;
    const dollarImpact = excessSize * lossRate * afterLoss.length;

    // Bonferroni correction across the within-detector tests: size Welch
    // (post-loss vs post-win) and the optional outcome Welch (big vs normal
    // post-loss). Previous code claimed significance if ANY test tripped at
    // α=0.05 — selection-bias inflation. Both tests are still attached to
    // `statistics` below for the global BH pass.
    const numTests = outcomeTest ? 2 : 1;
    const alphaBonf = 0.05 / numTests;
    const isSignificant =
      sizeTest.pValue < alphaBonf || (outcomeTest != null && outcomeTest.pValue < alphaBonf);
    const strongestTest = outcomeTest && outcomeTest.pValue < sizeTest.pValue ? outcomeTest : sizeTest;
    const impactScore   = computeImpactScore(dollarImpact, strongestTest, 0.7);

    const direction = sizeDiffPct > 0 ? 'larger' : 'smaller';
    const description =
      `Your average position size after a loss is ${avgAfterLoss.toFixed(4)} ` +
      `(${Math.abs(sizeDiffPct)}% ${direction} than after a win). ` +
      `${sizeTest.description}. ` +
      `These post-loss positions have a ${afterLossWinRate}% win rate vs ${overallWinRate}% overall.`;

    const suggestion = isSignificant && sizeDiffPct > 10
      ? 'Consider using fixed position sizing rules regardless of recent outcomes, or reduce size after losses rather than increasing.'
      : undefined;

    const statistics = outcomeTest ? [sizeTest, outcomeTest] : [sizeTest];

    return [{
      module: 'size-escalation',
      title: isSignificant && sizeDiffPct > 10 ? 'Pattern consistent with size escalation after losses' : 'Position Sizing Analysis',
      description,
      suggestion,
      severity: isSignificant && sizeDiffPct > 20 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: afterLoss.map((p) => p.id),
      data: {
        avgSizeAfterLoss: Math.round(avgAfterLoss * 10000) / 10000,
        avgSizeAfterWin: Math.round(avgAfterWin * 10000) / 10000,
        sizeDiffPct,
        afterLossWinRate,
        overallWinRate,
        afterLossCount: afterLoss.length,
        afterWinCount: afterWin.length,
        dollarImpact: Math.round(dollarImpact * 100) / 100,
        tradeCount: qualified.length,
      },
      statistics,
      impactScore,
      category: 'behavior',
      isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }

function pending(testName: string, n: number): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
