/**
 * Exit-optimizer insight.
 *
 * Detects systematic early exits — positions that closed well before their
 * maximum favorable excursion. Uses Welch's t-test to check whether regime
 * differences in exit efficiency are statistically significant before
 * calling out a "worst regime."
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, bucketByRegime, formatRegimeLabel } from './base';
import {
  welchTTest,
  computeImpactScore,
} from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_REGIME_N = 5;

export const exitOptimizerDetector: InsightDetector = {
  name: 'exit-optimizer',
  minimumPositions: 5,   // lowered so we can emit a "need more data" insight
  dimensions: ['exitEfficiency', 'moneyLeftOnTable', 'regimeAtEntry'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.exitEfficiency != null && p.moneyLeftOnTable != null,
    );

    // Surface a low-priority insight when there isn't enough data yet
    if (qualified.length < 20) {
      const needed = 20 - qualified.length;
      const placeholder: StatisticalTest = {
        testName: 'welch_t_test',
        pValue: 1,
        effectSize: 0,
        sampleSizeA: qualified.length,
        sampleSizeB: 0,
        isSignificant: false,
        description: `Not significant (insufficient data, N=${qualified.length}) — need more trades for reliable results`,
      };
      return [{
        module: 'exit-optimizer',
        title: 'Exit Analysis Pending',
        description: `Need ${needed} more closed trades with MFE/MAE data before exit analysis becomes reliable.`,
        severity: 'info',
        confidence: 0,
        affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [placeholder],
        impactScore: 0,
        category: 'exit',
        isSignificant: false,
        sampleSize: qualified.length,
      }];
    }

    const allEfficiencies = qualified.map((p) => p.exitEfficiency!);
    const overall = summarize(qualified);
    const regimeBuckets = bucketByRegime(qualified);

    // Per-regime stats + Welch t-test vs. the overall distribution
    const regimeResults: Record<string, { stats: ReturnType<typeof summarize>; test: StatisticalTest }> = {};
    const allRegimeTests: StatisticalTest[] = [];

    for (const [regime, bucket] of Object.entries(regimeBuckets)) {
      if (bucket.length < MIN_REGIME_N) continue;
      const stats = summarize(bucket);
      const regimeEff = bucket.map((p) => p.exitEfficiency!);
      // Compare this regime vs. all other positions (by ID to avoid value collision)
      const regimeSet = new Set(bucket.map((p) => p.id));
      const others = qualified.filter((p) => !regimeSet.has(p.id)).map((p) => p.exitEfficiency!);
      const test = others.length >= 2
        ? welchTTest(regimeEff, others)
        : welchTTest(regimeEff, allEfficiencies);
      regimeResults[regime] = { stats, test };
      allRegimeTests.push(test);
    }

    let testIdx = 0;
    for (const regime of Object.keys(regimeResults)) {
      regimeResults[regime].test = allRegimeTests[testIdx++];
    }

    // Find the worst regime that is statistically significant
    const significantEntries = Object.entries(regimeResults)
      .filter(([, { test }]) => test.isSignificant)
      .sort(([, a], [, b]) => a.stats.avgEfficiency - b.stats.avgEfficiency);

    const worstEntry = significantEntries[0] ?? null;
    const anySignificant = significantEntries.length > 0;

    // Projected gain from 20% absolute efficiency improvement in worst regime
    let projectedGain = 0;
    if (worstEntry && worstEntry[1].stats.avgEfficiency > 0) {
      const factor = 0.2 / worstEntry[1].stats.avgEfficiency;
      projectedGain = Math.round(worstEntry[1].stats.totalLeftOnTable * factor * 100) / 100;
    }

    const totalPnl = qualified.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
    const leftOnTableRatio = totalPnl > 0 ? overall.totalLeftOnTable / totalPnl : Infinity;
    const severity = leftOnTableRatio > 0.1 ? 'warning' : 'info';

    const efficiencyPct = Math.round(overall.avgEfficiency * 1000) / 10;

    let description: string;
    let suggestion: string | undefined;

    if (anySignificant && worstEntry) {
      const [worstRegime, { stats: worstStats }] = worstEntry;
      const worstPct = Math.round(worstStats.avgEfficiency * 1000) / 10;
      description = `You capture ${efficiencyPct}% of available moves on average. In ${formatRegimeLabel(worstRegime)} markets your exit efficiency drops to ${worstPct}% — a statistically significant difference. You're leaving $${Math.round(overall.totalLeftOnTable).toLocaleString()} on the table across ${qualified.length} trades.`;
      suggestion = `Consider holding winners longer in ${formatRegimeLabel(worstRegime)} conditions — your MFE data suggests moves continue significantly past your exit point.`;
    } else if (anySignificant) {
      description = `You capture ${efficiencyPct}% of available moves on average. You're leaving $${Math.round(overall.totalLeftOnTable).toLocaleString()} on the table across ${qualified.length} trades.`;
      suggestion = 'Consider holding winners longer — your MFE data suggests moves continue significantly past your exit point.';
    } else {
      description = `You capture ${efficiencyPct}% of available moves on average. Your exit efficiency is consistent across regimes (no statistically significant differences found). You're leaving $${Math.round(overall.totalLeftOnTable).toLocaleString()} on the table across ${qualified.length} trades.`;
    }

    // Best test for impactScore (lowest p-value across regime tests, or placeholder if none)
    const representativeTest = allRegimeTests.length > 0
      ? allRegimeTests.reduce((best, t) => (t.pValue < best.pValue ? t : best))
      : { pValue: 0.5, isSignificant: false, effectSize: 0, sampleSizeA: qualified.length, sampleSizeB: 0, testName: 'welch_t_test', description: '', correctionApplied: undefined };

    const impactScore = computeImpactScore(overall.totalLeftOnTable, representativeTest, 1.0);

    const regimeBreakdown: Record<string, any> = {};
    for (const [regime, { stats, test }] of Object.entries(regimeResults)) {
      regimeBreakdown[regime] = {
        avgEfficiency: Math.round(stats.avgEfficiency * 1000) / 1000,
        totalLeftOnTable: Math.round(stats.totalLeftOnTable * 100) / 100,
        count: stats.count,
        isSignificant: test.isSignificant,
        pValue: Math.round(test.pValue * 1000) / 1000,
      };
    }

    const allTests = allRegimeTests.length > 0 ? allRegimeTests : [representativeTest as StatisticalTest];

    return [{
      module: 'exit-optimizer',
      title: anySignificant ? 'Exit Optimization Opportunity' : 'Exit Efficiency Baseline',
      description,
      suggestion,
      severity,
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: qualified.map((p) => p.id),
      data: {
        avgEfficiency: Math.round(overall.avgEfficiency * 1000) / 1000,
        totalLeftOnTable: Math.round(overall.totalLeftOnTable * 100) / 100,
        worstRegime: worstEntry?.[0] ?? null,
        projectedGain,
        tradeCount: qualified.length,
      },
      regimeBreakdown,
      statistics: allTests,
      impactScore,
      category: 'exit',
      isSignificant: anySignificant,
      sampleSize: qualified.length,
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