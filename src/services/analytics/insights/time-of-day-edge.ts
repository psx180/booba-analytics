/**
 * Time-of-day edge insight.
 *
 * Hypothesis: some hours of the day are significantly better or worse
 * than all other hours. Applies Bonferroni correction for 24 comparisons.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, bonferroniCorrect, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 50;
const MIN_HOUR_N    = 10;

export const timeOfDayEdgeDetector: InsightDetector = {
  name: 'time-of-day-edge',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'entryHour', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    // Accept entryHour if computed, otherwise derive from firstEntryTime (UTC)
    const qualified = positions
      .filter((p) => p.aggregatePnl != null && (p.entryHour != null || p.firstEntryTime != null))
      .map((p) => ({
        id:          p.id,
        aggregatePnl: p.aggregatePnl!,
        entryHour:   p.entryHour ?? new Date(p.firstEntryTime!).getUTCHours(),
      }));

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'time-of-day-edge',
        title: 'Time-of-Day Analysis Pending',
        description: `Need ${needed} more trades spread across hours before time-of-day edge analysis is reliable.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'timing', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by hour
    const hourMap = new Map<number, number[]>(); // hour → pnls
    for (const p of qualified) {
      const h = p.entryHour;
      if (!hourMap.has(h)) hourMap.set(h, []);
      hourMap.get(h)!.push(p.aggregatePnl);
    }

    // Test each hour with ≥10 trades against the complement
    const hourResults: { hour: number; avgPnl: number; count: number; test: StatisticalTest }[] = [];

    for (const [hour, pnls] of hourMap) {
      if (pnls.length < MIN_HOUR_N) continue;
      const complement = qualified.filter((p) => p.entryHour !== hour).map((p) => p.aggregatePnl);
      if (complement.length < 2) continue;
      const test    = welchTTest(pnls, complement);
      const avgPnl  = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      hourResults.push({ hour, avgPnl, count: pnls.length, test });
    }

    if (hourResults.length === 0) {
      return [{
        module: 'time-of-day-edge',
        title: 'Time-of-Day Analysis Pending',
        description: `No single hour has ${MIN_HOUR_N}+ trades yet. Need more trading data spread across hours.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { tradeCount: qualified.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'timing', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Bonferroni correction
    const rawTests      = hourResults.map((h) => h.test);
    const corrected     = bonferroniCorrect(rawTests);
    const withCorrected = hourResults.map((h, i) => ({ ...h, test: corrected[i] }));

    const significant = withCorrected.filter((h) => h.test.isSignificant);
    const bestHour    = withCorrected.reduce((b, h) => (h.avgPnl > b.avgPnl ? h : b));
    const worstHour   = withCorrected.reduce((w, h) => (h.avgPnl < w.avgPnl ? h : w));

    const sigBest  = significant.length > 0
      ? significant.reduce((b, h) => (h.avgPnl > b.avgPnl ? h : b))
      : null;
    const sigWorst = significant.length > 0
      ? significant.reduce((w, h) => (h.avgPnl < w.avgPnl ? h : w))
      : null;

    let description: string;
    let suggestion:  string | undefined;

    if (significant.length === 0) {
      description =
        `After testing all ${withCorrected.length} active hours with Bonferroni correction for multiple comparisons: ` +
        `no hour-of-day edge detected — your performance is consistent across trading hours. ` +
        `Best hour: ${bestHour.hour}:00 (avg $${bestHour.avgPnl.toFixed(2)}), ` +
        `worst: ${worstHour.hour}:00 (avg $${worstHour.avgPnl.toFixed(2)}).`;
    } else {
      const bestStr  = sigBest  ? `Your best hour is ${sigBest.hour}:00 (avg $${sigBest.avgPnl.toFixed(2)}, ${sigBest.test.description})`   : '';
      const worstStr = sigWorst ? `Your worst is ${sigWorst.hour}:00 (avg $${sigWorst.avgPnl.toFixed(2)}, ${sigWorst.test.description})` : '';
      description =
        `After testing all ${withCorrected.length} active hours with Bonferroni correction: ` +
        `${significant.length} hour${significant.length > 1 ? 's' : ''} show significant differences. ` +
        `${bestStr}. ${worstStr}.`;
      if (sigBest && sigWorst) {
        suggestion = `Consider focusing your trading during ${sigBest.hour}:00 and reducing activity during ${sigWorst.hour}:00.`;
      }
    }

    // Dollar impact: losses from worst hour
    const worstHourPnls    = hourMap.get(worstHour.hour) ?? [];
    const worstHourTotalPnl = worstHourPnls.reduce((a, b) => a + b, 0);
    const dollarImpact      = Math.abs(Math.min(0, worstHourTotalPnl));

    const bestTestForImpact = corrected.reduce((b, t) => (t.pValue < b.pValue ? t : b), corrected[0]);
    const impactScore       = computeImpactScore(dollarImpact, bestTestForImpact, 0.7);
    const isSignificant     = significant.length > 0;

    const worstHourPositionIds = qualified.filter((p) => p.entryHour === worstHour.hour).map((p) => p.id);

    return [{
      module: 'time-of-day-edge',
      title: isSignificant ? 'Time-of-Day Edge Detected' : 'No Time-of-Day Edge',
      description,
      suggestion,
      severity: 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: worstHourPositionIds,
      data: {
        testedHours:     withCorrected.length,
        significantHours: significant.length,
        bestHour:        bestHour.hour,
        worstHour:       worstHour.hour,
        bestHourAvgPnl:  Math.round(bestHour.avgPnl * 100) / 100,
        worstHourAvgPnl: Math.round(worstHour.avgPnl * 100) / 100,
        tradeCount:      qualified.length,
      },
      statistics: corrected,
      impactScore,
      category: 'timing',
      isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

function pending(testName: string, n: number): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB: 0,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}
