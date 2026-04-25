/**
 * Revenge-trading insight.
 *
 * Hypothesis: trades placed while the trader is in a "tilted" behavioural
 * state perform worse than normal trades. The primary signal is
 * position.tiltScore (from the tilt detection service). If tilt scores
 * have not been computed yet we fall back to the original heuristic: a
 * trade entered within 15 minutes of a losing position's exit.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence, bucketByRegime } from './base';
import { welchTTest, chiSquaredProportionTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS      = 30;
const REVENGE_WINDOW     = 15 * 60 * 1000; // 15 minutes in ms (fallback heuristic)
const TILT_SCORE_CUTOFF  = 0.5;

export const revengeTradingDetector: InsightDetector = {
  name: 'revenge-trading',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'firstEntryTime', 'lastExitTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.firstEntryTime != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      const placeholder = pending('welch_t_test', qualified.length);
      return [{
        module: 'revenge-trading',
        title: 'Revenge Trading Analysis Pending',
        description: `Need ${needed} more trades. Watching whether trades placed within 15 minutes of a loss perform worse than normal.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [placeholder], impactScore: 0, category: 'behavior',
        isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Sort by entry time
    const sorted = [...qualified].sort(
      (a, b) => new Date(a.firstEntryTime!).getTime() - new Date(b.firstEntryTime!).getTime(),
    );

    // Pre-build a list of closed positions sorted by lastExitTime for lookups
    const closedByExit = qualified
      .filter((p) => p.lastExitTime != null)
      .sort((a, b) => new Date(a.lastExitTime!).getTime() - new Date(b.lastExitTime!).getTime());

    const revengeTrades: Position[] = [];
    const normalTrades: Position[]  = [];

    for (const pos of sorted) {
      // Primary signal: tilt score (from tilt detection service). If tilt
      // scores have been computed, use position.tiltScore > 0.5 as the
      // revenge-trade marker. If tiltScore is null for this position, fall
      // back to the original 15-minute-after-loss heuristic.
      let isRevengeTrade: boolean;

      if (pos.tiltScore != null) {
        isRevengeTrade = pos.tiltScore > TILT_SCORE_CUTOFF;
      } else {
        const entryMs = new Date(pos.firstEntryTime!).getTime();
        let latestExitMs = -Infinity;
        let latestPnl    = 0;
        for (const c of closedByExit) {
          if (c.id === pos.id) continue;
          const exitMs = new Date(c.lastExitTime!).getTime();
          if (exitMs >= entryMs) continue;                           // still open
          if (exitMs > latestExitMs) { latestExitMs = exitMs; latestPnl = c.aggregatePnl!; }
        }
        isRevengeTrade =
          latestExitMs > -Infinity &&
          entryMs - latestExitMs <= REVENGE_WINDOW &&
          latestPnl < 0;
      }

      if (isRevengeTrade) revengeTrades.push(pos);
      else                normalTrades.push(pos);
    }

    if (revengeTrades.length < 2) {
      const ph = pending('welch_t_test', qualified.length, 0);
      return [{
        module: 'revenge-trading',
        title: 'No Revenge Trading Detected',
        description: `Across ${qualified.length} trades, no pattern of re-entering within 15 minutes of a loss was found.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { revengeCount: revengeTrades.length, tradeCount: qualified.length },
        statistics: [ph], impactScore: 0, category: 'behavior',
        isSignificant: false, sampleSize: qualified.length,
      }];
    }

    const revengePnls = revengeTrades.map((p) => p.aggregatePnl!);
    const normalPnls  = normalTrades.map((p) => p.aggregatePnl!);
    const pnlTest     = welchTTest(revengePnls, normalPnls);

    const revengeWins = revengeTrades.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const normalWins  = normalTrades.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const winRateTest = chiSquaredProportionTest(
      revengeWins, revengeTrades.length,
      normalWins,  normalTrades.length,
    );

    const avgRevengePnl  = mean(revengePnls);
    const avgNormalPnl   = mean(normalPnls);
    const totalRevengePnl = sum(revengePnls);

    // Bonferroni correction across the two within-detector tests (P&L Welch
    // and win-rate chi-squared). The previous code took the smaller of the
    // two p-values as a "primary" test, which doubles the family-wise Type-I
    // rate. Both raw p-values are still passed to the global BH pass below
    // via `statistics: [pnlTest, winRateTest]` for cross-detector correction;
    // the Bonferroni gate here just keeps the *narrative* honest.
    const NUM_TESTS = 2;
    const ALPHA_BONF = 0.05 / NUM_TESTS;
    const isSignificant =
      pnlTest.pValue < ALPHA_BONF || winRateTest.pValue < ALPHA_BONF;
    // Use the lower-p test for impact-score *weighting* — that's ranking, not
    // a significance claim, so it doesn't suffer from the selection bias.
    const strongestTest  = pnlTest.pValue <= winRateTest.pValue ? pnlTest : winRateTest;
    const impactScore    = computeImpactScore(Math.abs(totalRevengePnl), strongestTest, 1.0);

    const firstDate = new Date(sorted[0].firstEntryTime!);
    const lastDate  = new Date(sorted[sorted.length - 1].firstEntryTime!);
    const period    = `${firstDate.toLocaleDateString()} – ${lastDate.toLocaleDateString()}`;
    const verb      = totalRevengePnl < 0 ? 'cost' : 'earned';

    // If the tilt detector has run, the signal is behaviour-based
    // (not just "15 minutes after a loss") — reflect that in the copy.
    const usingTiltSignal = sorted.some((p) => p.tiltScore != null);
    const signalPhrase    = usingTiltSignal
      ? 'while you were in a tilted state (elevated tilt score)'
      : 'within 15 minutes of a loss';

    const description =
      `You placed ${revengeTrades.length} trades ${signalPhrase}. ` +
      `These "revenge trades" have average P&L of $${avgRevengePnl.toFixed(2)} ` +
      `vs $${avgNormalPnl.toFixed(2)} for normal trades. ${pnlTest.description}. ` +
      `Revenge trading has ${verb} you $${Math.abs(Math.round(totalRevengePnl)).toLocaleString()} over ${period}.`;

    const suggestion = isSignificant
      ? 'Consider adding a cooldown period after losses. Even a 30-minute pause could prevent these impulsive re-entries.'
      : undefined;

    // Regime breakdown (on revenge trades only)
    const regimeBreakdown: Record<string, any> = {};
    for (const [regime, bucket] of Object.entries(bucketByRegime(revengeTrades))) {
      if (bucket.length < 3) continue;
      const pnls = bucket.map((p) => p.aggregatePnl ?? 0);
      const wins = bucket.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
      regimeBreakdown[regime] = {
        count: bucket.length,
        avgPnl: Math.round(mean(pnls) * 100) / 100,
        winRate: Math.round((wins / bucket.length) * 100),
        totalPnl: Math.round(sum(pnls) * 100) / 100,
      };
    }

    return [{
      module: 'revenge-trading',
      title: isSignificant ? 'Revenge Trading Detected' : 'Revenge Trading: Not Significant',
      description,
      suggestion,
      severity: isSignificant && totalRevengePnl < -500 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: revengeTrades.map((p) => p.id),
      data: {
        revengeCount: revengeTrades.length,
        normalCount: normalTrades.length,
        avgRevengePnl: Math.round(avgRevengePnl * 100) / 100,
        avgNormalPnl: Math.round(avgNormalPnl * 100) / 100,
        totalRevengePnl: Math.round(totalRevengePnl * 100) / 100,
        revengeWinRate: Math.round((revengeWins / revengeTrades.length) * 100),
        normalWinRate: Math.round((normalWins / normalTrades.length) * 100),
        tradeCount: qualified.length,
      },
      regimeBreakdown,
      statistics: [pnlTest, winRateTest],
      impactScore,
      category: 'behavior',
      isSignificant,
      sampleSize: qualified.length,
    }];
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
function sum(xs: number[]): number  { return xs.reduce((a, b) => a + b, 0); }

function pending(testName: string, n: number, sampleSizeB = 0): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: n, sampleSizeB,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${n}) — need more trades for reliable results`,
  };
}