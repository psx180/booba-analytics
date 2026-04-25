/**
 * Disposition-effect insight.
 *
 * Classic behavioral bias: holding losing positions longer than winners.
 *
 * Two measurement methods are run side by side. Both are reported in the
 * insight description and both are returned in `statistics`; the more
 * significant one becomes the primary narrative.
 *
 *   1. Hold-time ratio (legacy fallback) — average loser hold time divided
 *      by average winner hold time. Welch t-test on the two hold-time
 *      distributions.
 *
 *   2. PGR/PLR proxy (Odean 1998 — adapted for closed-trade history) — we
 *      can't observe live "decided not to close" events, so we use the
 *      reciprocal hold time as a proxy for realisation rate:
 *           PGR_proxy = 1 / avg_winner_hold_time
 *           PLR_proxy = 1 / avg_loser_hold_time
 *           Disposition = PGR_proxy - PLR_proxy   (positive ⇒ winners
 *                                                  realised faster)
 *      Welch t-test on the per-position 1/hold series for winners vs losers.
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

    // Method 1 — hold-time ratio (legacy fallback). Welch on raw hold times.
    const holdTimeTest = welchTTest(overall.winnerHoldTimes, overall.loserHoldTimes);

    // Method 2 — PGR/PLR proxy. Welch on the per-position realisation rates,
    // which are 1 / hold time. We filter zero-hold trades to keep the
    // reciprocal well-defined.
    const winnerRealisationRates = overall.winnerHoldTimes
      .filter((h) => h > 0)
      .map((h) => 1 / h);
    const loserRealisationRates  = overall.loserHoldTimes
      .filter((h) => h > 0)
      .map((h) => 1 / h);
    const pgrProxy = winnerRealisationRates.length > 0
      ? winnerRealisationRates.reduce((a, b) => a + b, 0) / winnerRealisationRates.length
      : 0;
    const plrProxy = loserRealisationRates.length > 0
      ? loserRealisationRates.reduce((a, b) => a + b, 0) / loserRealisationRates.length
      : 0;
    const dispositionDelta = pgrProxy - plrProxy; // positive ⇒ disposition
    const pgrTest = welchTTest(winnerRealisationRates, loserRealisationRates);

    // Bonferroni correction across the two related tests (raw hold-time
    // Welch + reciprocal-hold-time PGR/PLR Welch). The previous code picked
    // the smaller p-value as primary — selection bias that the global BH pass
    // can't undo because it sees only the chosen test, not the suppressed one.
    // Both tests are emitted in `statistics`, and the within-detector gate
    // below uses α/2 = 0.025 so the narrative claim is honestly corrected.
    const NUM_TESTS = 2;
    const ALPHA_BONF = 0.05 / NUM_TESTS;
    // For description purposes we still pick the lower-p test as the headline
    // — that's a ranking choice, not a significance claim.
    const strongestTest = pgrTest.pValue < holdTimeTest.pValue ? pgrTest : holdTimeTest;
    const test = strongestTest; // alias used by the existing branches below
    const bonferroniSignificant =
      pgrTest.pValue < ALPHA_BONF || holdTimeTest.pValue < ALPHA_BONF;

    // Estimate dollar cost of the disposition effect:
    //   extra hold time for losers × average loss rate per second × number of losers
    const avgLossPerSecond = overall.loserCount > 0 && overall.avgLoserHold > 0
      ? Math.abs(overall.totalLossPnl) / (overall.loserCount * overall.avgLoserHold)
      : 0;
    const extraHoldSeconds = Math.max(0, overall.avgLoserHold - overall.avgWinnerHold);
    const estimatedCost = extraHoldSeconds * avgLossPerSecond * overall.loserCount;

    const impactScore = computeImpactScore(estimatedCost, strongestTest, 0.7);

    // Both methods are reported in the description so the user sees that the
    // two analyses agree (or where they disagree).
    const pgrPlrRatio = plrProxy > 0 ? pgrProxy / plrProxy : 0;
    const methodLines =
      `Hold-time method: you hold losers ${overall.ratio.toFixed(2)}x longer than winners (${holdTimeTest.description}). ` +
      `PGR/PLR method: you realize gains ${pgrPlrRatio > 0 ? pgrPlrRatio.toFixed(2) + 'x' : 'comparably'} more readily than losses ` +
      `(${pgrTest.description}).`;

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

    if (!bonferroniSignificant) {
      // Not enough evidence — don't claim a disposition effect exists
      title       = 'No Disposition Effect Detected';
      description = `Your winner and loser hold times are similar (ratio ${ratio.toFixed(2)}x) and the difference is not statistically significant. This is a healthy sign — you're not systematically holding losers longer. ${methodLines}`;
      severity    = 'info';
    } else if (isHealthy) {
      title       = 'Healthy Exit Discipline';
      description = `You hold losing positions only ${ratio.toFixed(2)}x as long as winning positions — healthy exit discipline confirmed by statistical testing. Average winner: ${formatDuration(overall.avgWinnerHold)}, average loser: ${formatDuration(overall.avgLoserHold)}. ${methodLines}`;
      severity    = 'info';
    } else if (isElevated) {
      title       = 'Disposition Effect Detected';
      description = `You hold losing positions ${ratio.toFixed(1)}x longer than winning positions, and this difference is statistically significant. Average winner: ${formatDuration(overall.avgWinnerHold)}, average loser: ${formatDuration(overall.avgLoserHold)}. ${methodLines}${regimeNotes ? ' ' + regimeNotes : ''}`;
      suggestion  = 'Consider setting time-based stops or reviewing positions held longer than your average winner duration. The estimated cost of this pattern is $' + Math.round(estimatedCost).toLocaleString() + ' across all affected trades.';
      severity    = ratio >= CRITICAL_MIN ? 'warning' : 'info';
    } else {
      // Borderline (1.2 ≤ ratio < 1.5) but significant
      title       = 'Borderline Disposition Pattern';
      description = `You hold losers ${ratio.toFixed(2)}x longer than winners — statistically significant but moderate. ${methodLines}${regimeNotes ? ' ' + regimeNotes : ''} Watch for this drifting higher.`;
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
        // PGR/PLR proxy fields
        pgrProxy:        round4(pgrProxy),
        plrProxy:        round4(plrProxy),
        pgrPlrRatio:     round4(pgrPlrRatio),
        dispositionDelta: round4(dispositionDelta),
        primaryMethod:   pgrTest.pValue < holdTimeTest.pValue ? 'pgr_plr' : 'hold_time',
      },
      regimeBreakdown,
      // Emit BOTH tests so the global BH pass can correct on either; the
      // within-detector narrative gate above already used Bonferroni at α/2.
      statistics: [holdTimeTest, pgrTest],
      impactScore,
      category: 'behavior',
      isSignificant: bonferroniSignificant,
      sampleSize: qualified.length,
    }];
  },
};

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ─── Public helpers (consumed by other analytics modules) ─────────────────

/**
 * Lightweight disposition ratio for callers that just need the headline
 * number without running the full insight detector. Returns null when there
 * aren't enough winners + losers to compute a meaningful ratio.
 *
 * Used by the WART exit-quality axis fallback when MFE data isn't available.
 */
export function computeDispositionRatio(positions: Position[]): number | null {
  const qualified = positions.filter(
    (p) => p.holdTimeSeconds != null && p.aggregatePnl != null,
  );
  const stats = computeDisposition(qualified);
  return stats ? stats.ratio : null;
}

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