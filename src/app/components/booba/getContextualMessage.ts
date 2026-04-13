export interface BoobaAnalyticsData {
  untaggedPositionCount?: number;
  /** Total closed trade count. Analytics messages are suppressed below 15. */
  totalTrades?: number;
  /** ISO timestamp of the last analytics compute run. Used for stale-data nudge. */
  lastComputedAt?: string | null;
  wartResult?: {
    composite: number;
    axes?: {
      discipline?: { score: number };
      risk?: { score: number };
    };
  };
  tiltEpisodeCount?: number;
  eloResult?: {
    currentElo: number;
    peakElo: number;
    recentTrend: 'improving' | 'declining' | 'stable';
    tier: string;
  };
  entropyResult?: {
    compositeScore: number;
  };
  xpnlLuckScore?: number;
  insights?: Array<{
    module: string;
    title: string;
    description: string;
    isSignificant?: boolean;
    impactScore?: number;
    data?: Record<string, unknown>;
  }>;
  /** Social context for open positions — populated by ELFA enrichment. */
  openPositionSocialAlerts?: Array<{
    asset: string;
    mentionCount: number;
    sentimentScore: number;
    trendDirection: 'rising' | 'falling' | 'stable';
  }>;
}

export function getContextualMessage(
  page: 'dashboard' | 'trades' | 'analytics',
  data: BoobaAnalyticsData,
): string | null {
  if (page === 'dashboard') {
    const totalTrades = data.totalTrades ?? 0;
    const untagged = data.untaggedPositionCount ?? 0;

    // Below the minimum threshold, only show onboarding messages.
    // The untagged nudge is exempt — always useful regardless of trade count.
    if (totalTrades < 15) {
      if (untagged > 0) {
        return `${untagged} new trade${untagged === 1 ? '' : 's'} have no thesis. Want to add context?`;
      }
      const remaining = 15 - totalTrades;
      return totalTrades === 0
        ? 'Welcome! Start trading — analytics unlock after 15 trades.'
        : `Keep trading! Analytics unlock after ${remaining} more trade${remaining === 1 ? '' : 's'}.`;
    }

    // Build two pools: analytics messages and the untagged nudge.
    const analyticsMsgs: string[] = [];

    // Stale analytics nudge
    if (data.lastComputedAt) {
      const ageMs = Date.now() - new Date(data.lastComputedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours > 1) {
        const label =
          ageHours < 2    ? 'an hour ago'
          : ageHours < 24 ? `${Math.floor(ageHours)} hours ago`
          : `${Math.floor(ageHours / 24)} day${Math.floor(ageHours / 24) === 1 ? '' : 's'} ago`;
        analyticsMsgs.push(`Your analytics are from ${label}. Want me to refresh?`);
      }
    }

    // WART declining
    if (data.wartResult && data.wartResult.composite < 0) {
      analyticsMsgs.push('Your WART score dropped this week. Risk management is your weakest axis.');
    }

    // Tilt episodes
    const tiltEpisodes = data.tiltEpisodeCount ?? 0;
    if (tiltEpisodes > 0) {
      analyticsMsgs.push(
        `I detected ${tiltEpisodes} tilt episode${tiltEpisodes === 1 ? '' : 's'}. Your behavior changes after losses.`,
      );
    }

    // Elo at new peak
    if (
      data.eloResult &&
      data.eloResult.currentElo >= data.eloResult.peakElo &&
      data.eloResult.recentTrend === 'improving'
    ) {
      analyticsMsgs.push(`New Elo peak! You're trading at ${data.eloResult.tier} level.`);
    }

    // Discipline low
    if (data.entropyResult && data.entropyResult.compositeScore < 30) {
      analyticsMsgs.push("Your trading entropy is high — you might be scattered across too many setups.");
    }

    // Significant Markov finding
    const markovInsight = data.insights?.find(
      (i) => i.module.toLowerCase().includes('markov') && i.isSignificant,
    );
    if (markovInsight) {
      analyticsMsgs.push("After a loss, you lose again 65% of the time. That's above baseline.");
    }

    // Luck score negative
    if (data.xpnlLuckScore !== undefined && data.xpnlLuckScore < -0.3) {
      analyticsMsgs.push("Your actual P&L is below expected — you might be running unlucky.");
    }

    // WART positive — positive reinforcement
    if (data.wartResult && data.wartResult.composite > 1) {
      analyticsMsgs.push("Looking at your patterns...");
    }

    // Social shift alerts for held positions (low-priority pool candidate)
    if (data.openPositionSocialAlerts) {
      for (const alert of data.openPositionSocialAlerts) {
        const sentimentLabel =
          alert.sentimentScore > 0.3 ? 'bullish' : alert.sentimentScore < -0.3 ? 'bearish' : 'neutral';
        if (alert.trendDirection === 'rising') {
          analyticsMsgs.push(
            `${alert.asset} social attention up — ${alert.mentionCount} mentions/hr, sentiment ${sentimentLabel}`,
          );
        } else if (alert.trendDirection === 'falling') {
          analyticsMsgs.push(
            `${alert.asset} social attention declining — watch for momentum shift`,
          );
        }
      }
    }

    // Top significant insight
    const topInsight = data.insights
      ?.filter((i) => i.isSignificant && i.impactScore != null)
      .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];
    if (topInsight) {
      analyticsMsgs.push(topInsight.description);
    }

    const untaggedMsg =
      untagged > 0
        ? `${untagged} new trade${untagged === 1 ? '' : 's'} have no thesis. Want to add context?`
        : null;

    // Selection logic — rotate rather than always showing the same message
    if (analyticsMsgs.length > 0 && untaggedMsg) {
      // Both pools available: show untagged 30% of the time, analytics 70%
      if (Math.random() < 0.3) return untaggedMsg;
      return analyticsMsgs[Math.floor(Math.random() * analyticsMsgs.length)];
    }

    if (analyticsMsgs.length > 0) {
      return analyticsMsgs[Math.floor(Math.random() * analyticsMsgs.length)];
    }

    if (untaggedMsg) return untaggedMsg;

    return null;
  }

  if (page === 'trades') {
    return null;
  }

  if (page === 'analytics') {
    const topInsight = data.insights
      ?.filter((i) => i.isSignificant && i.impactScore != null)
      .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];

    if (topInsight) return topInsight.description;
    return null;
  }

  return null;
}
