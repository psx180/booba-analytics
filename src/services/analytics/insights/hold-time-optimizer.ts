/**
 * Hold-time optimizer insight.
 *
 * Hypothesis: there is an optimal hold-time quartile for each trade type —
 * positions held too short or too long underperform those in the sweet spot.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, formatDuration } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS       = 30;
const MIN_PER_TRADE_TYPE  = 20;

export const holdTimeOptimizerDetector: InsightDetector = {
  name: 'hold-time-optimizer',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'holdTimeSeconds', 'tradeType'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.holdTimeSeconds != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'hold-time-optimizer',
        title: 'Hold Time Analysis Pending',
        description: `Need ${needed} more trades with hold time data. Watching for optimal hold time patterns per trade type.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'exit', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by tradeType (or a single 'all' group)
    const byType = new Map<string, Position[]>();
    for (const p of qualified) {
      const tt = (p.manualTradeType ?? p.tradeType) ?? 'all';
      if (!byType.has(tt)) byType.set(tt, []);
      byType.get(tt)!.push(p);
    }

    interface Finding {
      tradeType:      string;
      optimalRange:   [number, number]; // seconds
      q1Range:        [number, number];
      q4Range:        [number, number];
      optimalAvgPnl:  number;
      outsideAvgPnl:  number;
      tooLongAvgPnl:  number;
      tooShortAvgPnl: number;
      test:           StatisticalTest;
      dollarImpact:   number;
    }

    const findings: Finding[] = [];

    for (const [tradeType, tradePositions] of byType) {
      if (tradePositions.length < MIN_PER_TRADE_TYPE) continue;

      // Sort by hold time and split into quartiles
      const sorted = [...tradePositions].sort(
        (a, b) => (a.holdTimeSeconds ?? 0) - (b.holdTimeSeconds ?? 0),
      );
      const n    = sorted.length;
      const cuts = [Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4)];

      const quartiles = [
        sorted.slice(0,       cuts[0]),
        sorted.slice(cuts[0], cuts[1]),
        sorted.slice(cuts[1], cuts[2]),
        sorted.slice(cuts[2]),
      ].filter((q) => q.length >= 2);

      if (quartiles.length < 2) continue;

      const qStats = quartiles.map((q) => {
        const pnls  = q.map((p) => p.aggregatePnl!);
        const holds = q.map((p) => p.holdTimeSeconds!);
        return {
          avgPnl: mean(pnls),
          minHold: Math.min(...holds),
          maxHold: Math.max(...holds),
          pnls,
        };
      });

      const bestIdx  = qStats.reduce((b, q, i) => (q.avgPnl > qStats[b].avgPnl ? i : b), 0);
      const worstIdx = qStats.reduce((w, q, i) => (q.avgPnl < qStats[w].avgPnl ? i : w), 0);
      if (bestIdx === worstIdx) continue;

      const test = welchTTest(qStats[bestIdx].pnls, qStats[worstIdx].pnls);

      const outsidePnls   = tradePositions.filter((_, i) => !quartiles[bestIdx].includes(_)).map((p) => p.aggregatePnl!);
      const outsideAvgPnl = outsidePnls.length > 0 ? mean(outsidePnls) : 0;

      // Dollar impact: gap between optimal and actual average × trade count
      const totalActualPnl    = mean(tradePositions.map((p) => p.aggregatePnl!));
      const dollarImpact      = Math.abs((qStats[bestIdx].avgPnl - totalActualPnl) * tradePositions.length);

      findings.push({
        tradeType,
        optimalRange:   [qStats[bestIdx].minHold, qStats[bestIdx].maxHold],
        q1Range:        [qStats[0].minHold, qStats[0].maxHold],
        q4Range:        [qStats[qStats.length - 1].minHold, qStats[qStats.length - 1].maxHold],
        optimalAvgPnl:  qStats[bestIdx].avgPnl,
        outsideAvgPnl,
        tooLongAvgPnl:  qStats[qStats.length - 1].avgPnl,
        tooShortAvgPnl: qStats[0].avgPnl,
        test,
        dollarImpact,
      });
    }

    if (findings.length === 0) {
      return [{
        module: 'hold-time-optimizer',
        title: 'Hold Time Analysis Pending',
        description: `Need at least ${MIN_PER_TRADE_TYPE} positions per trade type for hold time analysis.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { tradeCount: qualified.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'exit', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Top finding by dollar impact
    findings.sort((a, b) => b.dollarImpact - a.dollarImpact);
    const top         = findings[0];
    const primaryTest = top.test;
    const isSignificant = primaryTest.isSignificant;
    const impactScore   = computeImpactScore(top.dollarImpact, primaryTest, 0.7);

    const typeLabel = top.tradeType === 'all' ? 'overall' : top.tradeType.replace(/_/g, ' ');

    const description =
      `For your ${typeLabel} trades, the optimal hold time range is ` +
      `${formatDuration(top.optimalRange[0])}–${formatDuration(top.optimalRange[1])}. ` +
      `Positions in this range have avg P&L of $${top.optimalAvgPnl.toFixed(2)} ` +
      `vs $${top.outsideAvgPnl.toFixed(2)} outside it. ${primaryTest.description}. ` +
      `Trades held too long (>${formatDuration(top.q4Range[0])}): avg $${top.tooLongAvgPnl.toFixed(2)}. ` +
      `Trades closed too quickly (<${formatDuration(top.q1Range[1])}): avg $${top.tooShortAvgPnl.toFixed(2)}.`;

    const suggestion = isSignificant
      ? `Consider setting time-based alerts when ${typeLabel} positions reach ${formatDuration(top.optimalRange[1])} — your data suggests returns diminish beyond this point.`
      : undefined;

    // Per trade type breakdown
    const regimeBreakdown: Record<string, any> = {};
    for (const f of findings) {
      regimeBreakdown[f.tradeType] = {
        optimalRangeMin: f.optimalRange[0],
        optimalRangeMax: f.optimalRange[1],
        optimalAvgPnl:   Math.round(f.optimalAvgPnl * 100) / 100,
        outsideAvgPnl:   Math.round(f.outsideAvgPnl * 100) / 100,
        dollarImpact:    Math.round(f.dollarImpact * 100) / 100,
        isSignificant:   f.test.isSignificant,
        pValue:          Math.round(f.test.pValue * 1000) / 1000,
      };
    }

    return [{
      module: 'hold-time-optimizer',
      title: isSignificant ? 'Hold Time Pattern Detected' : 'Hold Time Analysis',
      description,
      suggestion,
      severity: isSignificant && top.dollarImpact > 500 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: qualified.map((p) => p.id),
      data: {
        topTradeType:    top.tradeType,
        optimalRangeMin: top.optimalRange[0],
        optimalRangeMax: top.optimalRange[1],
        optimalAvgPnl:   Math.round(top.optimalAvgPnl * 100) / 100,
        outsideAvgPnl:   Math.round(top.outsideAvgPnl * 100) / 100,
        dollarImpact:    Math.round(top.dollarImpact * 100) / 100,
        findingsCount:   findings.length,
        tradeCount:      qualified.length,
      },
      regimeBreakdown,
      statistics: findings.map((f) => f.test),
      impactScore,
      category: 'exit',
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
