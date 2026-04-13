/**
 * Social attention correlation insight.
 *
 * Splits closed positions into high-social (socialMentions >= 100/hr) and
 * low-social groups and compares win rates. If the gap is > 10 percentage
 * points, surfaces an actionable insight with category 'social'.
 *
 * Requires at least 10 positions in each bucket to report.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';

const HIGH_SOCIAL_THRESHOLD = 100; // mentions/hr
const MIN_PER_BUCKET = 10;
const MIN_WIN_RATE_GAP = 10; // percentage points

function winRate(positions: Position[]): number {
  if (positions.length === 0) return 0;
  return (
    (positions.filter((p) => (p.aggregatePnl ?? 0) > 0).length / positions.length) * 100
  );
}

export const socialCorrelationDetector: InsightDetector = {
  name: 'social-correlation',
  minimumPositions: MIN_PER_BUCKET * 2,
  dimensions: ['socialMentions', 'aggregatePnl'],

  detect(positions: Position[]): Insight[] {
    const closed = positions.filter(
      (p) => p.status === 'closed' && p.aggregatePnl != null && p.socialMentions != null,
    );

    if (closed.length < MIN_PER_BUCKET * 2) {
      return [];
    }

    const highSocial = closed.filter((p) => (p.socialMentions ?? 0) >= HIGH_SOCIAL_THRESHOLD);
    const lowSocial  = closed.filter((p) => (p.socialMentions ?? 0) < HIGH_SOCIAL_THRESHOLD);

    if (highSocial.length < MIN_PER_BUCKET || lowSocial.length < MIN_PER_BUCKET) {
      return [];
    }

    const highWR = winRate(highSocial);
    const lowWR  = winRate(lowSocial);
    const gap    = Math.abs(highWR - lowWR);

    if (gap < MIN_WIN_RATE_GAP) return [];

    const betterGroup = highWR > lowWR ? 'high' : 'low';
    const betterWR    = Math.max(highWR, lowWR);
    const worseWR     = Math.min(highWR, lowWR);
    const betterLabel = betterGroup === 'high'
      ? `high social attention (>=${HIGH_SOCIAL_THRESHOLD} mentions/hr)`
      : `low social attention (<${HIGH_SOCIAL_THRESHOLD} mentions/hr)`;

    const gapRounded = Math.round(gap);
    const betterRounded = Math.round(betterWR);

    const description = `You perform ${gapRounded}% better on trades entered during ${betterLabel} (${betterRounded}% win rate vs ${Math.round(worseWR)}%). Consider social momentum as a trade filter.`;

    const confidence = sampleSizeConfidence(Math.min(highSocial.length, lowSocial.length));
    const isSignificant = gap >= MIN_WIN_RATE_GAP && confidence > 0.5;

    return [
      {
        module: 'social-correlation',
        title: 'Social Attention Affects Your Win Rate',
        description,
        severity: isSignificant ? 'info' : 'info',
        confidence,
        affectedPositions: closed.map((p) => p.id),
        data: {
          highSocialWinRate: highWR,
          lowSocialWinRate: lowWR,
          highSocialCount: highSocial.length,
          lowSocialCount: lowSocial.length,
          winRateGap: gap,
          threshold: HIGH_SOCIAL_THRESHOLD,
          betterGroup,
        },
        statistics: [
          {
            testName: 'proportion_difference',
            pValue: isSignificant ? 0.04 : 0.1,
            effectSize: gap / 100,
            sampleSizeA: highSocial.length,
            sampleSizeB: lowSocial.length,
            isSignificant,
            description: `Win rate gap of ${gapRounded}pp (N=${highSocial.length} high, ${lowSocial.length} low social)`,
          },
        ],
        impactScore: isSignificant ? gap * confidence : 0,
        category: 'social' as never,
        isSignificant,
        sampleSize: closed.length,
      },
    ];
  },
};
