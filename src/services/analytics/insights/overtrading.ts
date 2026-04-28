/**
 * Overtrading insight.
 *
 * Hypothesis: days with more trades have worse overall P&L.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { pearsonCorrelation, welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 30;

export const overtradingDetector: InsightDetector = {
  name: 'overtrading',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.firstEntryTime != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'overtrading',
        title: 'Overtrading Analysis Pending',
        description: `Need ${needed} more trades. Watching whether days with more activity tend to have worse P&L.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('correlation', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by UTC date
    const dayMap = new Map<string, { count: number; pnl: number }>();
    for (const p of qualified) {
      const date = new Date(p.firstEntryTime!).toISOString().slice(0, 10);
      const d    = dayMap.get(date) ?? { count: 0, pnl: 0 };
      dayMap.set(date, { count: d.count + 1, pnl: d.pnl + (p.aggregatePnl ?? 0) });
    }

    if (dayMap.size < 4) {
      return [{
        module: 'overtrading',
        title: 'Overtrading Analysis Pending',
        description: `Only ${dayMap.size} trading days found — need at least 4 days of data for correlation analysis.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { dayCount: dayMap.size, tradeCount: qualified.length },
        statistics: [pending('correlation', dayMap.size)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    const days   = Array.from(dayMap.values());
    const counts = days.map((d) => d.count);
    const pnls   = days.map((d) => d.pnl);

    const corrTest = pearsonCorrelation(counts, pnls);

    // Median split: heavy vs light days
    const sortedCounts = [...counts].sort((a, b) => a - b);
    const median = sortedCounts[Math.floor(sortedCounts.length / 2)];

    const heavyDays  = days.filter((d) => d.count > median);
    const lightDays  = days.filter((d) => d.count <= median);
    const heavyPnls  = heavyDays.map((d) => d.pnl);
    const lightPnls  = lightDays.map((d) => d.pnl);

    const tTest = heavyPnls.length >= 2 && lightPnls.length >= 2
      ? welchTTest(heavyPnls, lightPnls)
      : null;

    const avgHeavy = heavyPnls.length > 0 ? mean(heavyPnls) : 0;
    const avgLight = lightPnls.length > 0 ? mean(lightPnls) : 0;

    const isNegativeCorr = avgHeavy < avgLight; // more trades → worse P&L
    const dollarImpact   = Math.abs(avgHeavy - avgLight) * heavyDays.length;
    // Bonferroni correction across the (up to two) within-detector tests:
    // Pearson correlation on count vs P&L, plus the optional median-split
    // Welch on heavy-day vs light-day P&L. The earlier code took the
    // smaller-of-two p-value as primary, which inflated Type-I roughly 2×.
    // Emit both raw p-values to the global BH pass via `statistics` below;
    // the within-detector gate uses α/k.
    const numTests = tTest ? 2 : 1;
    const alphaBonf = 0.05 / numTests;
    const isSignificant =
      corrTest.pValue < alphaBonf || (tTest != null && tTest.pValue < alphaBonf);
    // Strongest test (lowest p) drives impactScore weighting only — that's
    // ranking, not significance gating, so it's not biased.
    const strongestTest = tTest && tTest.pValue < corrTest.pValue ? tTest : corrTest;
    const impactScore   = computeImpactScore(dollarImpact, strongestTest, 0.7);

    const rSign = isNegativeCorr ? '-' : '+';
    const rStr  = `r=${rSign}${corrTest.effectSize.toFixed(2)}`;

    const description =
      `Correlation between daily trade count and P&L: ${rStr} (${corrTest.description}). ` +
      `On days with ${median + 1}+ trades, your average P&L is $${avgHeavy.toFixed(2)}. ` +
      `On lighter days (≤${median} trades), it's $${avgLight.toFixed(2)}.`;

    let suggestion: string | undefined;
    if (isSignificant && isNegativeCorr) {
      const lightMeanCount = sortedCounts.slice(0, Math.floor(sortedCounts.length / 2));
      const optimalCount   = lightMeanCount.length > 0
        ? Math.round(lightMeanCount.reduce((a, b) => a + b, 0) / lightMeanCount.length)
        : median;
      suggestion = `You tend to overtrade on losing days. Consider setting a maximum daily trade count or stopping after ${optimalCount} trades.`;
    }

    const statistics = tTest ? [corrTest, tTest] : [corrTest];

    return [{
      module: 'overtrading',
      title: isSignificant && isNegativeCorr ? 'Pattern consistent with overtrading' : 'Trade Frequency Analysis',
      description,
      suggestion,
      severity: isSignificant && isNegativeCorr ? 'warning' : 'info',
      confidence: sampleSizeConfidence(dayMap.size),
      affectedPositions: isSignificant ? qualified.map((p) => p.id) : [],
      data: {
        dayCount: dayMap.size,
        medianDailyTrades: median,
        avgHeavyDayPnl: Math.round(avgHeavy * 100) / 100,
        avgLightDayPnl: Math.round(avgLight * 100) / 100,
        heavyDayCount: heavyDays.length,
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
