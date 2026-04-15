/**
 * WART — Wins Above Replacement Trader insight.
 *
 * Wraps the on-demand WART score (`computeWartResult`) in an InsightDetector
 * so the score is included alongside the other behavioral insights in the
 * stored-observation pipeline. The insight is a single high-level summary
 * of the trader's profile across the five WART axes plus the strongest
 * improvement recommendation.
 *
 * Statistical backing: chi-squared proportion test of actual win rate vs
 * 50% (random baseline). Significant ⇒ the trader is reliably distinguished
 * from coin-flip selection. The test isn't WART itself — it's a sanity check
 * that the underlying trade record has enough signal to support the score.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { chiSquaredProportionTest, computeImpactScore } from '../statistics';
import { computeWartResult, type WartResult } from '../metrics/wart';
import { computeXpnlResult } from '../metrics/xpnl';
import { computeEntropyResult } from './entropy-insight';
import { equityCurveAggregator } from '../aggregations/equity-curve';

const MIN_POSITIONS = 50;

export const wartInsightDetector: InsightDetector = {
  name: 'wart',
  minimumPositions: MIN_POSITIONS,
  dimensions: [
    'aggregatePnl',
    'totalSize',
    'mfePnl',
    'entrySession',
    'tiltEpisodeId',
  ],

  detect(positions: Position[]): Insight[] {
    const closed = positions.filter(
      (p) => p.status === 'closed' && p.aggregatePnl != null,
    );
    if (closed.length < MIN_POSITIONS) return [];

    // Build the dependencies WART consumes. Reuse the live aggregator and
    // metric helpers so the insight reflects exactly what the dashboard sees.
    const xpnlResult    = computeXpnlResult(closed);
    const entropyResult = computeEntropyResult(closed);
    const equityResult  = equityCurveAggregator.aggregate(closed);
    const drawdown = {
      maxDrawdown:         equityResult.data.maxDrawdown ?? 0,
      maxDrawdownPct:      equityResult.data.maxDrawdownPct ?? 0,
      maxDrawdownDuration: equityResult.data.maxDrawdownDuration ?? 0,
      currentDrawdown:     equityResult.data.currentDrawdown ?? 0,
    };
    const equityTradeCount = equityResult.data.tradeCount ?? closed.length;

    const wart = computeWartResult(closed, {
      xpnlResult,
      entropyResult,
      drawdown,
      equityCurveTradeCount: equityTradeCount,
    });

    // Statistical backing: actual win rate vs 50% baseline.
    const winners = closed.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const total   = closed.length;
    const test = chiSquaredProportionTest(
      winners, total,
      Math.round(total / 2), total,
    );

    const { best, worst } = bestAndWorstAxis(wart);
    const sign = wart.composite >= 0 ? '+' : '';
    const headline = wart.improvements[0] ?? '';

    const title = `Trader Score: ${sign}${wart.composite.toFixed(1)} WART (${wart.tier})`;
    const description =
      `Your overall performance score is ${sign}${wart.composite.toFixed(1)} WART (${wart.tier}). ` +
      `Strongest axis: ${prettyAxis(best.name)} (${best.score.toFixed(0)}/100). ` +
      `Weakest axis: ${prettyAxis(worst.name)} (${worst.score.toFixed(0)}/100).` +
      (headline ? ` ${headline}` : '');

    // Impact score scales with how far the weakest axis is from 50 (the
    // average baseline). The further from average — in either direction —
    // the more there is to act on.
    const distanceFromAverage = Math.abs(50 - worst.score);
    const impactScore = computeImpactScore(distanceFromAverage, test, 0.7);

    return [{
      module: 'wart',
      title,
      description,
      severity: wart.composite < -1 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(closed.length),
      affectedPositions: closed.map((p) => p.id),
      data: {
        composite:     wart.composite,
        tier:          wart.tier,
        weightedScore: wart.weightedScore,
        axes:          wart.axes,
        improvements:  wart.improvements,
      },
      statistics: [test],
      impactScore,
      category: 'strategy',
      isSignificant: test.isSignificant,
      sampleSize: closed.length,
    }];
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function bestAndWorstAxis(wart: WartResult): {
  best:  { name: string; score: number };
  worst: { name: string; score: number };
} {
  const entries = Object.entries(wart.axes) as [string, { score: number }][];
  let best  = entries[0];
  let worst = entries[0];
  for (const e of entries) {
    if (e[1].score > best[1].score)  best  = e;
    if (e[1].score < worst[1].score) worst = e;
  }
  return {
    best:  { name: best[0],  score: best[1].score  },
    worst: { name: worst[0], score: worst[1].score },
  };
}

function prettyAxis(name: string): string {
  switch (name) {
    case 'entry':      return 'Entry Quality';
    case 'exit':       return 'Exit Quality';
    case 'risk':       return 'Risk Management';
    case 'timing':     return 'Timing';
    case 'discipline': return 'Discipline (WART)';
    default:           return name;
  }
}
