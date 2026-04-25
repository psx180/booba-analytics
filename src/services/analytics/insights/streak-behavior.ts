/**
 * Streak-behavior insight.
 *
 * Hypothesis: trader behaviour (size, hold time, outcomes) changes during
 * winning or losing streaks of 3+ consecutive trades.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS  = 40;
const STREAK_TRIGGER = 3; // consecutive wins/losses to enter "streak" state

export const streakBehaviorDetector: InsightDetector = {
  name: 'streak-behavior',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['aggregatePnl', 'totalSize', 'holdTimeSeconds', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.firstEntryTime != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'streak-behavior',
        title: 'Streak Behavior Analysis Pending',
        description: `Need ${needed} more trades. Watching for behavioural changes during winning or losing streaks of 3+.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Sort by entry time and label each trade by the streak at entry
    const sorted = [...qualified].sort(
      (a, b) => new Date(a.firstEntryTime!).getTime() - new Date(b.firstEntryTime!).getTime(),
    );

    type StreakType = 'win' | 'loss' | 'neutral';
    const labels: StreakType[] = [];
    let streak = 0; // positive = wins, negative = losses

    for (let i = 0; i < sorted.length; i++) {
      // Streak is computed from outcomes UP TO (not including) this trade
      labels.push(
        streak >= STREAK_TRIGGER  ? 'win'  :
        streak <= -STREAK_TRIGGER ? 'loss' :
        'neutral',
      );

      // Update streak with this trade's outcome
      const pnl = sorted[i].aggregatePnl ?? 0;
      if (pnl > 0)      streak = streak > 0 ? streak + 1 : 1;
      else if (pnl < 0) streak = streak < 0 ? streak - 1 : -1;
      else              streak = 0;
    }

    const winStreak  = sorted.filter((_, i) => labels[i] === 'win');
    const lossStreak = sorted.filter((_, i) => labels[i] === 'loss');
    const neutral    = sorted.filter((_, i) => labels[i] === 'neutral');

    if (winStreak.length < 2 && lossStreak.length < 2) {
      return [{
        module: 'streak-behavior',
        title: 'Streak Behavior Analysis Pending',
        description: `No streaks of ${STREAK_TRIGGER}+ consecutive wins or losses found yet. Need more sequential trading data.`,
        severity: 'info', confidence: sampleSizeConfidence(qualified.length), affectedPositions: [],
        data: { winStreakCount: winStreak.length, lossStreakCount: lossStreak.length },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Compare sizes
    const neutralSizes   = neutral.filter((p) => p.totalSize != null).map((p) => p.totalSize!);
    const winSizes       = winStreak.filter((p) => p.totalSize != null).map((p) => p.totalSize!);
    const lossSizes      = lossStreak.filter((p) => p.totalSize != null).map((p) => p.totalSize!);

    const winSizeTest  = winSizes.length >= 2 && neutralSizes.length >= 2
      ? welchTTest(winSizes, neutralSizes)  : null;
    const lossSizeTest = lossSizes.length >= 2 && neutralSizes.length >= 2
      ? welchTTest(lossSizes, neutralSizes) : null;

    // Compare P&L
    const neutralPnls = neutral.map((p) => p.aggregatePnl!);
    const winPnls     = winStreak.map((p) => p.aggregatePnl!);
    const lossPnls    = lossStreak.map((p) => p.aggregatePnl!);

    const winPnlTest  = winPnls.length >= 2 && neutralPnls.length >= 2
      ? welchTTest(winPnls, neutralPnls)  : null;
    const lossPnlTest = lossPnls.length >= 2 && neutralPnls.length >= 2
      ? welchTTest(lossPnls, neutralPnls) : null;

    // Aggregate stats
    const avgNeutralSize   = mean(neutralSizes);
    const avgWinSize       = mean(winSizes);
    const avgLossSize      = mean(lossSizes);
    const winSizePct       = avgNeutralSize > 0 ? Math.round(((avgWinSize  / avgNeutralSize) - 1) * 100) : 0;
    const lossSizePct      = avgNeutralSize > 0 ? Math.round(((avgLossSize / avgNeutralSize) - 1) * 100) : 0;

    const winStreakWins     = winStreak.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const winStreakWinRate  = winStreak.length > 0 ? Math.round((winStreakWins / winStreak.length) * 100) : 0;
    const overallWins       = qualified.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const overallWinRate    = Math.round((overallWins / qualified.length) * 100);

    const lossStreakWins    = lossStreak.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const lossStreakWinRate = lossStreak.length > 0 ? Math.round((lossStreakWins / lossStreak.length) * 100) : 0;

    const winStreakTotalPnl  = winPnls.reduce((a, b) => a + b, 0);
    const lossStreakTotalPnl = lossPnls.reduce((a, b) => a + b, 0);
    const totalStreakPnl     = winStreakTotalPnl + lossStreakTotalPnl;

    // Tilt-episode overlap: if trades in a losing streak share a
    // tiltEpisodeId, the streak triggered (or occurred inside) a
    // detected tilt episode. Count the distinct episode IDs that
    // overlap with losing-streak positions.
    const lossStreakEpisodeIds = new Set(
      lossStreak.map((p) => p.tiltEpisodeId).filter((id): id is string => id != null),
    );
    const winStreakEpisodeIds = new Set(
      winStreak.map((p) => p.tiltEpisodeId).filter((id): id is string => id != null),
    );
    const streakTiltEpisodes = lossStreakEpisodeIds.size + winStreakEpisodeIds.size;
    const tiltDataAvailable  = qualified.some((p) => p.tiltScore != null);

    const allTests = [winSizeTest, lossSizeTest, winPnlTest, lossPnlTest].filter(
      (t): t is NonNullable<typeof t> => t !== null,
    );

    const placeholderTest: StatisticalTest = {
      testName: 'welch_t_test', pValue: 1, effectSize: 0,
      sampleSizeA: qualified.length, sampleSizeB: 0, isSignificant: false,
      description: 'Not significant (insufficient streak data)',
    };

    // Bonferroni correction across the (up to four) within-detector tests:
    // size and P&L Welch tests for both win and loss streaks. The previous
    // code declared significance if ANY of the four tripped at α=0.05 — that
    // inflates family-wise Type-I roughly 4×. Emit all four to the global BH
    // pass via `statistics` for cross-detector correction; the narrative gate
    // here uses α/k.
    const strongestTest = allTests.length > 0
      ? allTests.reduce((b, t) => (t.pValue < b.pValue ? t : b))
      : placeholderTest;
    const numTests = Math.max(1, allTests.length);
    const alphaBonf = 0.05 / numTests;
    const isSignificant = allTests.some((t) => t.pValue < alphaBonf);
    const dollarImpact  = Math.abs(Math.min(0, winStreakTotalPnl) + Math.min(0, lossStreakTotalPnl));
    const impactScore   = computeImpactScore(dollarImpact, strongestTest, 0.7);

    let description = '';

    if (winStreak.length >= 2) {
      description +=
        `During winning streaks (${STREAK_TRIGGER}+ consecutive wins), ` +
        `your average position size ${winSizePct > 0 ? 'increases' : 'decreases'} ` +
        `${Math.abs(winSizePct)}% and your win rate ` +
        `${winStreakWinRate < overallWinRate ? 'drops' : 'holds'} at ${winStreakWinRate}% ` +
        `(from ${overallWinRate}% overall). `;
    }
    if (lossStreak.length >= 2) {
      description +=
        `During losing streaks (${STREAK_TRIGGER}+), ` +
        `size ${lossSizePct > 0 ? 'increases' : 'decreases'} ${Math.abs(lossSizePct)}% ` +
        `and win rate is ${lossStreakWinRate}%. `;
    }

    const verb = totalStreakPnl < 0 ? 'cost' : 'earned';
    description += `Streak-influenced trades have ${verb} you $${Math.abs(Math.round(totalStreakPnl)).toLocaleString()}.`;
    if (allTests.length > 0) description += ` ${strongestTest.description}.`;

    if (tiltDataAvailable && lossStreakEpisodeIds.size > 0) {
      description +=
        ` ${lossStreakEpisodeIds.size} losing streak${lossStreakEpisodeIds.size === 1 ? '' : 's'} ` +
        `coincide${lossStreakEpisodeIds.size === 1 ? 's' : ''} with a detected tilt episode — ` +
        `the streak triggered a measurable behavioural shift.`;
    }

    const suggestion = isSignificant
      ? 'Be especially mindful of position sizing during streaks — the data suggests your behaviour changes in ways that hurt performance.'
      : undefined;

    return [{
      module: 'streak-behavior',
      title: isSignificant ? 'Streak-Influenced Behaviour Detected' : 'Streak Behaviour: No Significant Pattern',
      description,
      suggestion,
      severity: isSignificant && dollarImpact > 200 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: [...winStreak, ...lossStreak].map((p) => p.id),
      data: {
        winStreakCount:     winStreak.length,
        lossStreakCount:    lossStreak.length,
        neutralCount:       neutral.length,
        winStreakWinRate,
        lossStreakWinRate,
        overallWinRate,
        winSizeChangePct:   winSizePct,
        lossSizeChangePct:  lossSizePct,
        winStreakTotalPnl:  Math.round(winStreakTotalPnl * 100) / 100,
        lossStreakTotalPnl: Math.round(lossStreakTotalPnl * 100) / 100,
        tradeCount:         qualified.length,
        streakTiltEpisodes,
        lossStreakTiltEpisodes: lossStreakEpisodeIds.size,
        winStreakTiltEpisodes:  winStreakEpisodeIds.size,
      },
      statistics: allTests.length > 0 ? allTests : [placeholderTest],
      impactScore,
      category: 'behavior',
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
