/**
 * Disposition-effect insight.
 *
 * Classic behavioral bias: holding losing positions longer than winners.
 * Uses Welch's t-test to confirm the hold-time difference is statistically
 * significant before labelling it a "disposition effect." If not significant,
 * emits an informational "no disposition effect detected" finding instead of
 * presenting a noisy ratio as fact.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, bucketByRegime, formatDuration } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS   = 20;
const HEALTHY_MAX     = 1.2;
const ELEVATED_MIN    = 1.5;
const CRITICAL_MIN    = 2.0;

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

    // Primary statistical test: do winners and losers have different hold times?
    const test = welchTTest(overall.winnerHoldTimes, overall.loserHoldTimes);

    // Estimate dollar cost of the disposition effect:
    //   extra hold time for losers × average loss rate per second × number of losers
    const avgLossPerSecond = overall.loserCount > 0 && overall.avgLoserHold > 0
      ? Math.abs(overall.totalLossPnl) / (overall.loserCount * overall.avgLoserHold)
      : 0;
    const extraHoldSeconds = Math.max(0, overall.avgLoserHold - overall.avgWinnerHold);
    const estimatedCost = extraHoldSeconds * avgLossPerSecond * overall.loserCount;

    const impactScore = computeImpactScore(estimatedCost, test, 0.7);

    // Regime breakdown — test each regime independently
    const regimeBuckets = bucketByRegime(qualified);
    const regimeBreakdown: Record<string, any> = {};

    for (const [regime, bucket] of Object.entries(regimeBuckets)) {
      if (bucket.length < 10) continue;
      const d = computeDisposition(bucket);
      if (!d) continue;
      const regimeTest = bucket.filter(p => (p.aggregatePnl ?? 0) > 0).length >= 2 &&
                         bucket.filter(p => (p.aggregatePnl ?? 0) < 0).length >= 2
        ? welchTTest(d.winnerHoldTimes, d.loserHoldTimes)
        : null;

      regimeBreakdown[regime] = {
        ratio: Math.round(d.ratio * 100) / 100,
        avgWinnerHoldSeconds: Math.round(d.avgWinnerHold),
        avgLoserHoldSeconds: Math.round(d.avgLoserHold),
        count: bucket.length,
        isSignificant: regimeTest?.isSignificant ?? false,
        pValue: regimeTest ? Math.round(regimeTest.pValue * 1000) / 1000 : null,
      };
    }

    // Build regime-specific annotation if there are interesting differences
    const regimeNotes = buildRegimeNotes(regimeBreakdown, overall.ratio);

    const ratio      = overall.ratio;
    const isElevated = ratio >= ELEVATED_MIN;
    const isHealthy  = ratio < HEALTHY_MAX;

    // Override severity/title/description based on significance
    let title: string;
    let description: string;
    let suggestion: string | undefined;
    let severity: Insight['severity'];

    if (!test.isSignificant) {
      // Not enough evidence — don't claim a disposition effect exists
      title       = 'No Disposition Effect Detected';
      description = `Your winner and loser hold times are similar (ratio ${ratio.toFixed(2)}x) and the difference is not statistically significant (${test.description}). This is a healthy sign — you're not systematically holding losers longer.`;
      severity    = 'info';
    } else if (isHealthy) {
      title       = 'Healthy Exit Discipline';
      description = `You hold losing positions only ${ratio.toFixed(2)}x as long as winning positions — healthy exit discipline confirmed by statistical testing (${test.description}). Average winner: ${formatDuration(overall.avgWinnerHold)}, average loser: ${formatDuration(overall.avgLoserHold)}.`;
      severity    = 'info';
    } else if (isElevated) {
      title       = 'Disposition Effect Detected';
      description = `You hold losing positions ${ratio.toFixed(1)}x longer than winning positions, and this difference is statistically significant (${test.description}). Average winner: ${formatDuration(overall.avgWinnerHold)}, average loser: ${formatDuration(overall.avgLoserHold)}.${regimeNotes ? ' ' + regimeNotes : ''}`;
      suggestion  = 'Consider setting time-based stops or reviewing positions held longer than your average winner duration. The estimated cost of this pattern is $' + Math.round(estimatedCost).toLocaleString() + ' across all affected trades.';
      severity    = ratio >= CRITICAL_MIN ? 'warning' : 'info';
    } else {
      // Borderline (1.2 ≤ ratio < 1.5) but significant
      title       = 'Borderline Disposition Pattern';
      description = `You hold losers ${ratio.toFixed(2)}x longer than winners — statistically significant but moderate (${test.description}).${regimeNotes ? ' ' + regimeNotes : ''} Watch for this drifting higher.`;
      severity    = 'info';
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
        estimatedCost: Math.round(estimatedCost * 100) / 100,
      },
      regimeBreakdown,
      statistics: [test],
      impactScore,
      category: 'behavior',
      isSignificant: test.isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

interface DispositionStats {
  ratio: number;
  avgWinnerHold: number;
  avgLoserHold: number;
  winnerCount: number;
  loserCount: number;
  winnerHoldTimes: number[];
  loserHoldTimes: number[];
  totalLossPnl: number;
}

function computeDisposition(positions: Position[]): DispositionStats | null {
  const winnerHoldTimes: number[] = [];
  const loserHoldTimes: number[] = [];
  let totalLossPnl = 0;

  for (const p of positions) {
    const pnl  = p.aggregatePnl ?? 0;
    const hold = p.holdTimeSeconds ?? 0;
    if (pnl > 0)      winnerHoldTimes.push(hold);
    else if (pnl < 0) { loserHoldTimes.push(hold); totalLossPnl += pnl; }
  }

  if (winnerHoldTimes.length === 0 || loserHoldTimes.length === 0) return null;

  const avgWinnerHold = winnerHoldTimes.reduce((a, b) => a + b, 0) / winnerHoldTimes.length;
  const avgLoserHold  = loserHoldTimes.reduce((a, b) => a + b, 0)  / loserHoldTimes.length;
  if (avgWinnerHold === 0) return null;

  return {
    ratio: avgLoserHold / avgWinnerHold,
    avgWinnerHold,
    avgLoserHold,
    winnerCount: winnerHoldTimes.length,
    loserCount: loserHoldTimes.length,
    winnerHoldTimes,
    loserHoldTimes,
    totalLossPnl,
  };
}

function buildRegimeNotes(
  regimeBreakdown: Record<string, any>,
  overallRatio: number,
): string | null {
  const sig = Object.entries(regimeBreakdown)
    .filter(([, d]) => d.isSignificant)
    .sort(([, a], [, b]) => b.ratio - a.ratio);

  if (sig.length === 0) return null;

  const [worstRegime, worstData] = sig[0];
  const label = worstRegime.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const notSig = Object.entries(regimeBreakdown)
    .filter(([, d]) => !d.isSignificant && d.count >= 10)
    .map(([r]) => r.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));

  let note = `Your disposition effect is worst in ${label} markets (${worstData.ratio.toFixed(1)}x, p=${worstData.pValue?.toFixed(3) ?? '?'})`;
  if (notSig.length > 0) {
    note += ` but not present in ${notSig.join(', ')} markets`;
  }
  note += '.';
  return note;
}