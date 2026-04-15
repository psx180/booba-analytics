/**
 * Outlier-dependency insight.
 *
 * Hypothesis: overall profitability depends on a small number of outsized
 * winners. If removing the top 1–10 trades flips total P&L negative, the
 * strategy is fragile and dependent on tail events.
 *
 * No t-test needed — this is descriptive. Uses a dummy StatisticalTest with
 * testName 'descriptive' and isSignificant based on whether the top 10% of
 * trades account for more than 50% of total P&L.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 20;

export const outlierDependencyDetector: InsightDetector = {
  name: 'outlier-dependency',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter((p) => p.aggregatePnl != null);

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'outlier-dependency',
        title: 'Outlier Dependency Analysis Pending',
        description: `Need ${needed} more closed trades. Watching whether a small number of winners drive all profitability.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending(qualified.length)],
        impactScore: 0, category: 'risk', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Sort descending by P&L
    const sorted    = [...qualified].sort((a, b) => (b.aggregatePnl ?? 0) - (a.aggregatePnl ?? 0));
    const totalPnl  = sorted.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);

    // Top 10%
    const top10Count = Math.max(1, Math.round(sorted.length * 0.1));
    const topPositions = sorted.slice(0, top10Count);
    const topPnl       = topPositions.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
    const topPct       = totalPnl !== 0 ? Math.round((topPnl / totalPnl) * 100) : 0;

    // Progressive removal: find how many top trades must be removed to go negative
    const CHECK_NS     = [1, 2, 3, 5, 10].filter((n) => n <= sorted.length);
    const removalImpacts = CHECK_NS.map((n) => ({
      n,
      pnlAfter: Math.round(sorted.slice(n).reduce((s, p) => s + (p.aggregatePnl ?? 0), 0) * 100) / 100,
    }));

    let minRemovalsForNegative = -1;
    for (const { n, pnlAfter } of removalImpacts) {
      if (pnlAfter < 0 && minRemovalsForNegative === -1) {
        minRemovalsForNegative = n;
        break;
      }
    }

    // isSignificant if top 10% accounts for >50% of (positive) P&L
    const isDependentOnOutliers = totalPnl > 0 && topPct > 50;

    const dummyTest: StatisticalTest = {
      testName: 'descriptive',
      pValue:      1,
      effectSize:  Math.min(1, Math.abs(topPct) / 100),
      sampleSizeA: topPositions.length,
      sampleSizeB: sorted.length - topPositions.length,
      isSignificant: false,
      description: isDependentOnOutliers
        ? `Descriptive — top ${top10Count} trades drive >50% of P&L`
        : `Descriptive — P&L is reasonably distributed across trades`,
    };

    const impactScore = computeImpactScore(topPnl, dummyTest, 0.4);

    const tradePct = Math.round((top10Count / sorted.length) * 100);
    let description =
      `Your top ${top10Count} trades (${tradePct}% of all trades) account for ${topPct}% of your total P&L ($${Math.round(totalPnl).toLocaleString()} overall). `;

    if (minRemovalsForNegative !== -1) {
      const pnlAfter = removalImpacts.find((r) => r.n === minRemovalsForNegative)?.pnlAfter ?? 0;
      description +=
        `If you remove your best ${minRemovalsForNegative} trade${minRemovalsForNegative > 1 ? 's' : ''}, ` +
        `your total P&L drops from $${Math.round(totalPnl).toLocaleString()} to $${pnlAfter.toLocaleString()}. ` +
        `Your profitability depends entirely on ${minRemovalsForNegative} outsized winner${minRemovalsForNegative > 1 ? 's' : ''} — ` +
        `without them you'd be net negative.`;
    } else {
      const r1 = removalImpacts.find((r) => r.n === 1);
      if (r1) {
        description +=
          `If you remove your best trade, total P&L drops from $${Math.round(totalPnl).toLocaleString()} to $${r1.pnlAfter.toLocaleString()}.`;
      }
    }

    const suggestion =
      `This isn't necessarily bad — many successful strategies rely on occasional big winners. ` +
      `But ensure your risk management protects against the scenario where those big winners don't appear for an extended period.`;

    return [{
      module: 'outlier-dependency',
      title: isDependentOnOutliers ? 'Outlier-Dependent Profitability' : 'Well-Distributed P&L',
      description,
      suggestion,
      severity: isDependentOnOutliers && minRemovalsForNegative !== -1 && minRemovalsForNegative <= 3 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: topPositions.map((p) => p.id),
      data: {
        totalPnl:               Math.round(totalPnl * 100) / 100,
        top10PctCount:          top10Count,
        top10PctPnl:            Math.round(topPnl * 100) / 100,
        top10PctShare:          topPct,
        minRemovalsForNegative,
        removalImpacts,
        tradeCount:             qualified.length,
      },
      statistics: [dummyTest],
      impactScore,
      category: 'risk',
      isSignificant: isDependentOnOutliers,
      sampleSize: qualified.length,
    }];
  },
};

function pending(n: number): StatisticalTest {
  return {
    testName: 'descriptive', pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
