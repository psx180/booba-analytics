export interface BoobaAnalyticsData {
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
}

export function getContextualMessage(
  page: 'dashboard' | 'trades' | 'analytics',
  data: BoobaAnalyticsData,
): string | null {
  if (page === 'dashboard') {
    // 1. WART declining (composite below 0)
    if (data.wartResult && data.wartResult.composite < 0) {
      return 'Your WART score dropped this week. Risk management is your weakest axis.';
    }

    // 2. Tilt episodes detected
    const tiltEpisodes = data.tiltEpisodeCount ?? 0;
    if (tiltEpisodes > 0) {
      return `I detected ${tiltEpisodes} tilt episode${tiltEpisodes === 1 ? '' : 's'}. Your behavior changes after losses.`;
    }

    // 3. Elo at new peak
    if (
      data.eloResult &&
      data.eloResult.currentElo >= data.eloResult.peakElo &&
      data.eloResult.recentTrend === 'improving'
    ) {
      return `New Elo peak! You're trading at ${data.eloResult.tier} level.`;
    }

    // 4. Discipline score low
    if (data.entropyResult && data.entropyResult.compositeScore < 30) {
      return "Your trading entropy is high — you might be scattered across too many setups.";
    }

    // 5. Significant Markov finding
    const markovInsight = data.insights?.find(
      (i) => i.module.toLowerCase().includes('markov') && i.isSignificant,
    );
    if (markovInsight) {
      return "After a loss, you lose again 65% of the time. That's above baseline.";
    }

    // 6. Luck score negative
    if (data.xpnlLuckScore !== undefined && data.xpnlLuckScore < -0.3) {
      return "Your actual P&L is below expected — you might be running unlucky.";
    }

    // 7. WART positive — positive reinforcement
    if (data.wartResult && data.wartResult.composite > 1) {
      return "Looking at your patterns...";
    }

    return null;
  }

  if (page === 'trades') {
    return null;
  }

  if (page === 'analytics') {
    // Surface the top insight by impact score
    const topInsight = data.insights
      ?.filter((i) => i.isSignificant && i.impactScore != null)
      .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];

    if (topInsight) {
      return topInsight.description;
    }

    return null;
  }

  return null;
}
