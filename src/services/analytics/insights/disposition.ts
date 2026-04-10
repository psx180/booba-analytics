/**
 * Disposition-effect insight.
 *
 * Classic behavioral bias: holding losing positions longer than winners.
 * Computes the ratio avgHoldTimeLosers / avgHoldTimeWinners and emits an
 * insight when it's elevated (> 1.5) or when it looks healthy (< 1.2).
 *
 * Requires ≥20 closed positions with hold time data.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, bucketByRegime, formatDuration } from './base';

const MIN_POSITIONS = 20;
const HEALTHY_MAX = 1.2;
const ELEVATED_MIN = 1.5;
const CRITICAL_MIN = 2.0;

export const dispositionDetector: InsightDetector = {
  name: 'disposition',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['holdTimeSeconds', 'aggregatePnl', 'regimeAtEntry'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.holdTimeSeconds != null && p.aggregatePnl != null,
    );
    if (qualified.length < MIN_POSITIONS) return [];

    const overall = computeDisposition(qualified);
    if (!overall) return [];

    const regimeBuckets = bucketByRegime(qualified);
    const regimeBreakdown: Record<string, any> = {};
    for (const [regime, bucket] of Object.entries(regimeBuckets)) {
      if (bucket.length < 10) continue;
      const d = computeDisposition(bucket);
      if (d) {
        regimeBreakdown[regime] = {
          ratio: Math.round(d.ratio * 100) / 100,
          avgWinnerHoldSeconds: Math.round(d.avgWinnerHold),
          avgLoserHoldSeconds: Math.round(d.avgLoserHold),
          count: bucket.length,
        };
      }
    }

    const ratio = overall.ratio;
    const isElevated = ratio >= ELEVATED_MIN;
    const isHealthy = ratio < HEALTHY_MAX;

    let title: string;
    let description: string;
    let suggestion: string | undefined;
    let severity: Insight['severity'];

    if (isElevated) {
      title = 'Disposition Effect Detected';
      description = `You hold losing positions ${ratio.toFixed(1)}x longer than winning positions. Average winner hold time: ${formatDuration(overall.avgWinnerHold)}. Average loser hold time: ${formatDuration(overall.avgLoserHold)}.`;
      suggestion = 'Consider setting time-based stops or reviewing positions that have been held longer than your average winner duration.';
      severity = ratio >= CRITICAL_MIN ? 'warning' : 'info';
    } else if (isHealthy) {
      title = 'Healthy Exit Discipline';
      description = `You hold losing positions only ${ratio.toFixed(2)}x as long as winning positions — a sign of healthy exit discipline. Average winner hold time: ${formatDuration(overall.avgWinnerHold)}. Average loser hold time: ${formatDuration(overall.avgLoserHold)}.`;
      severity = 'info';
    } else {
      // 1.2 ≤ ratio < 1.5 — borderline, still emit info-level insight
      title = 'Borderline Disposition Pattern';
      description = `You hold losers ${ratio.toFixed(2)}x longer than winners on average. This is borderline — watch for it drifting higher.`;
      severity = 'info';
    }

    return [{
      module: 'disposition',
      title,
      description,
      suggestion,
      severity,
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: qualified.map((p) => p.id),
      data: {
        ratio: Math.round(ratio * 100) / 100,
        avgWinnerHoldSeconds: Math.round(overall.avgWinnerHold),
        avgLoserHoldSeconds: Math.round(overall.avgLoserHold),
        winnerCount: overall.winnerCount,
        loserCount: overall.loserCount,
        tradeCount: qualified.length,
      },
      regimeBreakdown,
    }];
  },
};

interface DispositionStats {
  ratio: number;
  avgWinnerHold: number;
  avgLoserHold: number;
  winnerCount: number;
  loserCount: number;
}

function computeDisposition(positions: Position[]): DispositionStats | null {
  let winnerHoldSum = 0;
  let loserHoldSum = 0;
  let winnerCount = 0;
  let loserCount = 0;

  for (const p of positions) {
    const pnl = p.aggregatePnl ?? 0;
    const hold = p.holdTimeSeconds ?? 0;
    if (pnl > 0) {
      winnerHoldSum += hold;
      winnerCount++;
    } else if (pnl < 0) {
      loserHoldSum += hold;
      loserCount++;
    }
  }

  if (winnerCount === 0 || loserCount === 0) return null;

  const avgWinnerHold = winnerHoldSum / winnerCount;
  const avgLoserHold = loserHoldSum / loserCount;
  if (avgWinnerHold === 0) return null;

  return {
    ratio: avgLoserHold / avgWinnerHold,
    avgWinnerHold,
    avgLoserHold,
    winnerCount,
    loserCount,
  };
}