/**
 * Tilt-episodes insight.
 *
 * Consumes tiltEpisodeId / tiltScore that the tilt service has already
 * persisted on each position. Groups positions by episode, computes the
 * in-episode vs out-of-episode P&L delta with Welch's t-test, and
 * reports what the trader's P&L would have looked like if they had
 * paused during detected tilt episodes.
 *
 * Hypothesis: trades placed during detected tilt episodes under-perform
 * compared to trades placed in a normal behavioural state.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { welchTTest, computeImpactScore } from '../statistics';
import type { StatisticalTest } from '../types';

const MIN_POSITIONS = 30;

export const tiltEpisodesDetector: InsightDetector = {
  name: 'tilt-episodes',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['tiltScore', 'tiltEpisodeId', 'aggregatePnl', 'firstEntryTime'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.firstEntryTime != null && p.aggregatePnl != null,
    );

    if (qualified.length < MIN_POSITIONS) {
      const needed = MIN_POSITIONS - qualified.length;
      return [{
        module: 'tilt-episodes',
        title: 'Tilt Episode Analysis Pending',
        description: `Need ${needed} more trades. Watching for behavioural deviations — periods where frequency, sizing, and hold times shift away from your baseline.`,
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, needed, episodes: [] },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Tilt data must have been computed for this to run meaningfully.
    const withTiltData = qualified.filter((p) => p.tiltScore != null);
    if (withTiltData.length === 0) {
      return [{
        module: 'tilt-episodes',
        title: 'Tilt Detection Not Yet Run',
        description:
          'Tilt scores have not been computed for any positions yet. Run Compute Analytics to enable tilt-episode insights.',
        severity: 'info', confidence: 0, affectedPositions: [],
        data: { tradeCount: qualified.length, episodes: [] },
        statistics: [pending('welch_t_test', qualified.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: qualified.length,
      }];
    }

    // Group by episode id.
    const episodeMap = new Map<string, Position[]>();
    for (const p of withTiltData) {
      if (p.tiltEpisodeId == null) continue;
      const existing = episodeMap.get(p.tiltEpisodeId) ?? [];
      existing.push(p);
      episodeMap.set(p.tiltEpisodeId, existing);
    }

    const inside  = withTiltData.filter((p) => p.tiltEpisodeId != null);
    const outside = withTiltData.filter((p) => p.tiltEpisodeId == null);

    const avgTiltScore = mean(withTiltData.map((p) => p.tiltScore ?? 0));

    if (episodeMap.size === 0) {
      return [{
        module: 'tilt-episodes',
        title: 'No Tilt Episodes Detected',
        description:
          `Your trading behavior has been consistent across ${withTiltData.length} analysed trades. ` +
          `Your tilt scores average ${avgTiltScore.toFixed(2)} on a 0-1 scale — no sustained deviations from your personal baseline were found.`,
        severity: 'info',
        confidence: sampleSizeConfidence(withTiltData.length),
        affectedPositions: [],
        data: {
          tradeCount: withTiltData.length,
          avgTiltScore: Math.round(avgTiltScore * 1000) / 1000,
          episodeCount: 0,
          episodes: [],
        },
        statistics: [pending('welch_t_test', withTiltData.length)],
        impactScore: 0, category: 'behavior', isSignificant: false, sampleSize: withTiltData.length,
      }];
    }

    // Basic episode stats.
    const totalEpisodes   = episodeMap.size;
    const episodeSizes    = Array.from(episodeMap.values()).map((ps) => ps.length);
    const avgEpisodeSize  = mean(episodeSizes);

    const insidePnls  = inside.map((p) => p.aggregatePnl!);
    const outsidePnls = outside.map((p) => p.aggregatePnl!);
    const totalInside  = sum(insidePnls);
    const totalOutside = sum(outsidePnls);
    const avgInside    = inside.length  > 0 ? totalInside  / inside.length  : 0;
    const avgOutside   = outside.length > 0 ? totalOutside / outside.length : 0;

    // Welch's t-test: in-episode vs out-of-episode per-trade P&L.
    const pnlTest = insidePnls.length >= 2 && outsidePnls.length >= 2
      ? welchTTest(insidePnls, outsidePnls)
      : pending('welch_t_test', inside.length, outside.length);

    // How much of total losses landed inside an episode?
    const totalLosses   = sum(withTiltData.filter((p) => (p.aggregatePnl ?? 0) < 0)
                                          .map((p) => p.aggregatePnl!));
    const insideLosses  = sum(inside.filter((p) => (p.aggregatePnl ?? 0) < 0)
                                    .map((p) => p.aggregatePnl!));
    const insideLossShare = totalLosses < 0
      ? Math.round((insideLosses / totalLosses) * 100)
      : 0;

    // Most common trigger. The detector doesn't persist triggers alongside
    // positions (they're episode-level metadata), so we infer the dominant
    // trigger at insight time from the prefix of each episode's first
    // position: consecutive_losses if ≥3 of the previous 5 trades were
    // losses, otherwise behavioral_shift. This keeps us aligned with the
    // change-point detector's logic without coupling the two modules.
    const sortedAll = [...qualified].sort(
      (a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime(),
    );
    const triggerCounts = new Map<string, number>();
    for (const [, members] of episodeMap) {
      const first       = members[0];
      const firstIdx    = sortedAll.findIndex((p) => p.id === first.id);
      const lookback    = firstIdx > 0 ? sortedAll.slice(Math.max(0, firstIdx - 5), firstIdx) : [];
      const lossCount   = lookback.filter((p) => (p.aggregatePnl ?? 0) < 0).length;
      const trigger     = lossCount >= 3 ? 'consecutive_losses'
                        : lossCount >= 1 ? 'drawdown'
                        : 'behavioral_shift';
      triggerCounts.set(trigger, (triggerCounts.get(trigger) ?? 0) + 1);
    }
    const sortedTriggers = Array.from(triggerCounts.entries()).sort((a, b) => b[1] - a[1]);
    const mostCommonTrigger = sortedTriggers.length > 0 ? sortedTriggers[0][0] : 'behavioral_shift';

    // Counterfactual: if you had skipped in-episode trades entirely, what
    // would the total P&L be?
    const realTotalPnl  = totalInside + totalOutside;
    const pausedTotalPnl = totalOutside;
    const improvement   = pausedTotalPnl - realTotalPnl; // positive = better to pause

    // Time period label.
    const firstTime = sortedAll[0].firstEntryTime!;
    const lastTime  = sortedAll[sortedAll.length - 1].firstEntryTime!;
    const period    = `${firstTime.toLocaleDateString()} – ${lastTime.toLocaleDateString()}`;

    const isSignificant = pnlTest.isSignificant && improvement > 0;
    const impactScore   = computeImpactScore(Math.abs(improvement), pnlTest, 0.7);

    const description =
      `Detected ${totalEpisodes} tilt episode${totalEpisodes === 1 ? '' : 's'} over ${period}. ` +
      `During these episodes (${inside.length} trades), your average P&L was $${avgInside.toFixed(2)} ` +
      `vs $${avgOutside.toFixed(2)} during normal trading. ${pnlTest.description}. ` +
      `Tilt episodes account for ${Math.max(0, insideLossShare)}% of your total losses. ` +
      `Most common trigger: ${humanTrigger(mostCommonTrigger)}. ` +
      `If you had paused trading during detected tilt periods, your total P&L would ` +
      `${improvement >= 0 ? 'improve' : 'decrease'} by $${Math.abs(Math.round(improvement)).toLocaleString()}.`;

    const suggestion = isSignificant
      ? 'The change-point detector identified these episodes from shifts in your trade frequency, position sizing, and hold times — not just losses. Consider setting a "cool down" rule when you notice yourself trading faster and bigger than usual.'
      : undefined;

    return [{
      module: 'tilt-episodes',
      title: isSignificant ? 'Tilt Episodes Hurting P&L' : 'Tilt Episodes Detected',
      description,
      suggestion,
      severity: isSignificant && improvement > 500 ? 'warning' : 'info',
      confidence: sampleSizeConfidence(withTiltData.length),
      affectedPositions: inside.map((p) => p.id),
      data: {
        totalEpisodes,
        avgEpisodeSize      : Math.round(avgEpisodeSize * 100) / 100,
        insideCount         : inside.length,
        outsideCount        : outside.length,
        avgInsidePnl        : Math.round(avgInside  * 100) / 100,
        avgOutsidePnl       : Math.round(avgOutside * 100) / 100,
        totalInsidePnl      : Math.round(totalInside  * 100) / 100,
        totalOutsidePnl     : Math.round(totalOutside * 100) / 100,
        avgTiltScore        : Math.round(avgTiltScore * 1000) / 1000,
        insideLossSharePct  : insideLossShare,
        mostCommonTrigger,
        counterfactualImprovement: Math.round(improvement * 100) / 100,
        tradeCount          : withTiltData.length,
        episodes            : Array.from(episodeMap.entries()).map(([id, members]) => {
          const times = members
            .filter((p) => p.firstEntryTime != null)
            .map((p) => p.firstEntryTime!.getTime());
          const pnls = members.map((p) => p.aggregatePnl ?? 0);
          return {
            id,
            startDate : times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
            endDate   : times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
            tradeCount: members.length,
            totalPnl  : Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100,
          };
        }),
      },
      statistics: [pnlTest],
      impactScore,
      category: 'behavior',
      isSignificant,
      sampleSize: withTiltData.length,
    }];
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function humanTrigger(trigger: string): string {
  switch (trigger) {
    case 'consecutive_losses': return 'consecutive losses';
    case 'large_loss'        : return 'a single large loss';
    case 'drawdown'          : return 'a drawdown';
    case 'size_spike'        : return 'a sudden size increase';
    case 'frequency_spike'   : return 'rapid-fire trading';
    case 'hold_time_collapse': return 'impulsively short holds';
    case 'behavioral_shift'  : return 'a behavioural shift';
    default                  : return trigger.replace(/_/g, ' ');
  }
}

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
function sum(xs: number[]): number  { return xs.reduce((a, b) => a + b, 0); }

function pending(testName: string, nA: number, nB = 0): StatisticalTest {
  return {
    testName, pValue: 1, effectSize: 0, sampleSizeA: nA, sampleSizeB: nB,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${nA + nB}) — need more trades for reliable results`,
  };
}
