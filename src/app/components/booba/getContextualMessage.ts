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
  /** Drawdown analysis from risk metrics. */
  drawdownAnalysis?: {
    currentDrawdown: number;
    currentDrawdownDuration: number;
    avgDrawdownDuration: number;
    maxDrawdown: number;
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
  /** Carry trade context — populated by CarryOpportunities component. */
  carryData?: {
    topOpportunity?: {
      symbol: string;
      stabilityScore: number;
      netApr: number | null;
      fundingAprGross: number;
      userHasMatchingShort: boolean;
    };
    utilizationPct?: number | null;
    payingFundingSymbols?: string[];
  };
}

export type BoobaMessageMood = 'calm' | 'alert' | 'nervous' | 'excited';

export interface BoobaMessage {
  text: string;
  mood: BoobaMessageMood;
}

function m(text: string, mood: BoobaMessageMood): BoobaMessage {
  return { text, mood };
}

export function getContextualMessage(
  page: 'dashboard' | 'trades' | 'analytics',
  data: BoobaAnalyticsData,
): BoobaMessage | null {
  if (page === 'dashboard') {
    const totalTrades = data.totalTrades ?? 0;
    const untagged = data.untaggedPositionCount ?? 0;

    // Below the minimum threshold, only show onboarding messages.
    // The untagged nudge is exempt — always useful regardless of trade count.
    if (totalTrades < 15) {
      if (untagged > 0) {
        return m(`${untagged} new trade${untagged === 1 ? '' : 's'} have no thesis. Want to add context?`, 'calm');
      }
      const remaining = 15 - totalTrades;
      return totalTrades === 0
        ? m('Welcome! Start trading — analytics unlock after 15 trades.', 'calm')
        : m(`Keep trading! Analytics unlock after ${remaining} more trade${remaining === 1 ? '' : 's'}.`, 'calm');
    }

    // Build two pools: analytics messages and the untagged nudge.
    const analyticsMsgs: BoobaMessage[] = [];

    // Stale analytics nudge
    if (data.lastComputedAt) {
      const ageMs = Date.now() - new Date(data.lastComputedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours > 1) {
        const label =
          ageHours < 2    ? 'an hour ago'
          : ageHours < 24 ? `${Math.floor(ageHours)} hours ago`
          : `${Math.floor(ageHours / 24)} day${Math.floor(ageHours / 24) === 1 ? '' : 's'} ago`;
        analyticsMsgs.push(m(`Your analytics are from ${label}. Want me to refresh?`, 'calm'));
      }
    }

    // WART declining
    if (data.wartResult && data.wartResult.composite < 0) {
      analyticsMsgs.push(m('Your WART score dropped this week. Risk management is your weakest axis.', 'alert'));
    }

    // Tilt episodes
    const tiltEpisodes = data.tiltEpisodeCount ?? 0;
    if (tiltEpisodes > 0) {
      analyticsMsgs.push(
        m(`I detected ${tiltEpisodes} tilt episode${tiltEpisodes === 1 ? '' : 's'}. Your behavior changes after losses.`, 'alert'),
      );
    }

    // Elo at new peak
    if (
      data.eloResult &&
      data.eloResult.currentElo >= data.eloResult.peakElo &&
      data.eloResult.recentTrend === 'improving'
    ) {
      analyticsMsgs.push(m(`New Elo peak! You're trading at ${data.eloResult.tier} level.`, 'excited'));
    }

    // Discipline low
    if (data.entropyResult && data.entropyResult.compositeScore < 30) {
      analyticsMsgs.push(m("Your trading entropy is high — you might be scattered across too many setups.", 'nervous'));
    }

    // Significant Markov finding
    const markovInsight = data.insights?.find(
      (i) => i.module.toLowerCase().includes('markov') && i.isSignificant,
    );
    if (markovInsight) {
      analyticsMsgs.push(m("After a loss, you lose again 65% of the time. That's above baseline.", 'alert'));
    }

    // Luck score negative
    if (data.xpnlLuckScore !== undefined && data.xpnlLuckScore < -0.3) {
      analyticsMsgs.push(m("Your actual P&L is below expected — you might be running unlucky.", 'nervous'));
    }

    // Drawdown awareness
    if (data.drawdownAnalysis && data.drawdownAnalysis.currentDrawdown < 0) {
      const dd = data.drawdownAnalysis;
      if (dd.avgDrawdownDuration > 0 && dd.currentDrawdownDuration > dd.avgDrawdownDuration * 1.5) {
        const current = Math.round(dd.currentDrawdownDuration);
        const avg = Math.round(dd.avgDrawdownDuration);
        analyticsMsgs.push(
          m(`You have been in a drawdown for ${current} day${current === 1 ? '' : 's'} — longer than your average recovery time of ${avg} day${avg === 1 ? '' : 's'}.`, 'alert'),
        );
      } else if (dd.maxDrawdown < 0 && dd.currentDrawdown < dd.maxDrawdown * 0.5) {
        analyticsMsgs.push(
          m('Your current drawdown is approaching your historical maximum. Consider reducing position sizes.', 'alert'),
        );
      }
    }

    // WART positive — positive reinforcement
    if (data.wartResult && data.wartResult.composite > 1) {
      analyticsMsgs.push(m("Looking at your patterns...", 'calm'));
    }

    // Carry trade awareness
    if (data.carryData) {
      const { topOpportunity, utilizationPct, payingFundingSymbols } = data.carryData;

      // Paying-funding warning (highest priority carry message)
      if (payingFundingSymbols && payingFundingSymbols.length > 0) {
        const sym = payingFundingSymbols[0];
        analyticsMsgs.push(
          m(`${sym} funding rate is charging you > 0.03%/hr. Consider closing or hedging your long.`, 'alert'),
        );
      }

      // High-quality opportunity
      if (
        topOpportunity &&
        topOpportunity.stabilityScore >= 4 &&
        (topOpportunity.netApr ?? topOpportunity.fundingAprGross) > 30
      ) {
        const apr = (topOpportunity.netApr ?? topOpportunity.fundingAprGross).toFixed(0);
        analyticsMsgs.push(
          m(`${topOpportunity.symbol} carry at ${apr}% APR with ${topOpportunity.stabilityScore}-star stability. Deposit spot + short perps.`, 'excited'),
        );
      }

      // Utilization spike warning
      if (utilizationPct != null && utilizationPct > 70) {
        analyticsMsgs.push(
          m(`Borrow utilization at ${utilizationPct.toFixed(0)}% — rates may spike. Watch carry positions.`, 'nervous'),
        );
      }

      // Active carry encouragement
      if (topOpportunity?.userHasMatchingShort) {
        const apr = (topOpportunity.netApr ?? topOpportunity.fundingAprGross).toFixed(0);
        analyticsMsgs.push(
          m(`Your ${topOpportunity.symbol} carry trade is running. Earning ~${apr}% APR delta-neutral.`, 'excited'),
        );
      }
    }

    // Social shift alerts for held positions (low-priority pool candidate)
    if (data.openPositionSocialAlerts) {
      for (const alert of data.openPositionSocialAlerts) {
        const sentimentLabel =
          alert.sentimentScore > 0.3 ? 'bullish' : alert.sentimentScore < -0.3 ? 'bearish' : 'neutral';
        if (alert.trendDirection === 'rising') {
          analyticsMsgs.push(
            m(`${alert.asset} social attention up — ${alert.mentionCount} mentions/hr, sentiment ${sentimentLabel}`, 'alert'),
          );
        } else if (alert.trendDirection === 'falling') {
          analyticsMsgs.push(
            m(`${alert.asset} social attention declining — watch for momentum shift`, 'nervous'),
          );
        }
      }
    }

    // Top significant insight
    const topInsight = data.insights
      ?.filter((i) => i.isSignificant && i.impactScore != null)
      .sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];
    if (topInsight) {
      analyticsMsgs.push(m(topInsight.description, 'calm'));
    }

    const untaggedMsg: BoobaMessage | null =
      untagged > 0
        ? m(`${untagged} new trade${untagged === 1 ? '' : 's'} have no thesis. Want to add context?`, 'calm')
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

    if (topInsight) return m(topInsight.description, 'calm');
    return null;
  }

  return null;
}
