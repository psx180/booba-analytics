/**
 * Exit-optimizer insight.
 *
 * Detects a pattern of systematically early exits — positions that closed
 * well before their maximum favorable excursion.
 *
 * Requires ≥20 closed positions with exitEfficiency computed. Computes
 * average efficiency overall and per regime, finds the worst regime, and
 * projects the gain from a 20% improvement there.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, bucketByRegime, formatRegimeLabel } from './base';

const MIN_POSITIONS = 20;

export const exitOptimizerDetector: InsightDetector = {
  name: 'exit-optimizer',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['exitEfficiency', 'moneyLeftOnTable', 'regimeAtEntry'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.exitEfficiency != null && p.moneyLeftOnTable != null,
    );
    if (qualified.length < MIN_POSITIONS) return [];

    const overall = summarize(qualified);
    const regimeBuckets = bucketByRegime(qualified);

    const regimeStats: Record<string, ReturnType<typeof summarize>> = {};
    for (const [regime, bucket] of Object.entries(regimeBuckets)) {
      if (bucket.length >= 5) regimeStats[regime] = summarize(bucket);
    }

    // Find the regime with the lowest average efficiency (among those with enough data).
    const worst = Object.entries(regimeStats)
      .sort(([, a], [, b]) => a.avgEfficiency - b.avgEfficiency)[0];

    const worstRegime = worst?.[0] ?? null;
    const worstStats = worst?.[1] ?? null;

    // Projected gain: if efficiency in the worst regime improved by 20% (absolute),
    // how much additional P&L would that capture?
    let projectedGain = 0;
    if (worstStats && worstStats.avgEfficiency > 0) {
      const improvementFactor = 0.2 / worstStats.avgEfficiency;
      projectedGain = Math.round(worstStats.totalLeftOnTable * improvementFactor * 100) / 100;
    }

    // Severity: are we leaving more than 10% of total P&L on the table?
    const totalPnl = qualified.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
    const leftOnTableRatio = totalPnl > 0 ? overall.totalLeftOnTable / totalPnl : Infinity;
    const severity = leftOnTableRatio > 0.1 ? 'warning' : 'info';

    const efficiencyPct = Math.round(overall.avgEfficiency * 1000) / 10;
    const worstPct = worstStats ? Math.round(worstStats.avgEfficiency * 1000) / 10 : null;

    const description = worstRegime && worstStats
      ? `You capture ${efficiencyPct}% of available moves on average. In ${formatRegimeLabel(worstRegime)} markets, you only capture ${worstPct}%. You're leaving $${Math.round(overall.totalLeftOnTable).toLocaleString()} on the table across ${qualified.length} trades.`
      : `You capture ${efficiencyPct}% of available moves on average. You're leaving $${Math.round(overall.totalLeftOnTable).toLocaleString()} on the table across ${qualified.length} trades.`;

    const suggestion = worstRegime
      ? `Consider holding winners longer in ${formatRegimeLabel(worstRegime)} conditions — your MFE data suggests moves continue significantly past your exit point.`
      : 'Consider holding winners longer — your MFE data suggests moves continue significantly past your exit point.';

    const regimeBreakdown: Record<string, any> = {};
    for (const [regime, stats] of Object.entries(regimeStats)) {
      regimeBreakdown[regime] = {
        avgEfficiency: Math.round(stats.avgEfficiency * 1000) / 1000,
        totalLeftOnTable: Math.round(stats.totalLeftOnTable * 100) / 100,
        count: stats.count,
      };
    }

    return [{
      module: 'exit-optimizer',
      title: 'Exit Optimization Opportunity',
      description,
      suggestion,
      severity,
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: qualified.map((p) => p.id),
      data: {
        avgEfficiency: Math.round(overall.avgEfficiency * 1000) / 1000,
        totalLeftOnTable: Math.round(overall.totalLeftOnTable * 100) / 100,
        worstRegime,
        projectedGain,
        tradeCount: qualified.length,
      },
      regimeBreakdown,
    }];
  },
};

function summarize(positions: Position[]) {
  let sumEff = 0;
  let sumLeft = 0;
  let count = 0;
  for (const p of positions) {
    if (p.exitEfficiency != null) {
      sumEff += p.exitEfficiency;
      count++;
    }
    if (p.moneyLeftOnTable != null) {
      sumLeft += p.moneyLeftOnTable;
    }
  }
  return {
    avgEfficiency: count > 0 ? sumEff / count : 0,
    totalLeftOnTable: sumLeft,
    count,
  };
}
