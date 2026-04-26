/**
 * Syndrome definitions and signal extractors.
 *
 * Each syndrome lists the required, supporting, and contradicting signals
 * that determine its confidence level. Each signal is a pure extractor over
 * SyndromeInputData; extractors never throw — missing or malformed data
 * resolves to `insufficient_data`, which is treated distinctly from `absent`
 * (the difference matters: one means "we tested and found nothing", the
 * other means "we couldn't test").
 */

import type { Insight, StatisticalTest } from '../types';
import type { SignalDef, SyndromeDef, SyndromeInputData, SyndromeSignal } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function findInsight(insights: Insight[], module: string): Insight | undefined {
  return insights.find((i) => i.module === module);
}

function pickPrimaryPValue(insight: Insight | undefined): number | null {
  if (!insight || !insight.statistics || insight.statistics.length === 0) return null;
  const sig = insight.statistics.find((t) => t.isSignificant);
  const pick = sig ?? insight.statistics.reduce(
    (b: StatisticalTest, t: StatisticalTest) => (t.pValue < b.pValue ? t : b),
    insight.statistics[0],
  );
  return typeof pick.pValue === 'number' ? pick.pValue : null;
}

function insufficient(name: string, displayName: string, why: string): SyndromeSignal {
  return { name, displayName, status: 'insufficient_data', pValue: null, description: why };
}

function present(
  name: string,
  displayName: string,
  description: string,
  pValue: number | null,
): SyndromeSignal {
  return { name, displayName, status: 'present', pValue, description };
}

function absent(
  name: string,
  displayName: string,
  description: string,
  pValue: number | null,
): SyndromeSignal {
  return { name, displayName, status: 'absent', pValue, description };
}

/** Composite OR-extractor: returns 'present' if any sub-signal is present;
 *  'insufficient_data' if all sub-signals are insufficient; otherwise
 *  'absent'. The description is the strongest sub-signal's description. */
function compositeOr(name: string, displayName: string, parts: SignalDef[]): SignalDef {
  return {
    name,
    displayName,
    extract(data: SyndromeInputData): SyndromeSignal {
      const sub = parts.map((p) => p.extract(data));
      const presentSub = sub.filter((s) => s.status === 'present');
      if (presentSub.length > 0) {
        const labels = presentSub.map((s) => s.description).join('; ');
        const minP = presentSub.reduce<number | null>((b, s) => {
          if (s.pValue == null) return b;
          if (b == null) return s.pValue;
          return s.pValue < b ? s.pValue : b;
        }, null);
        return { name, displayName, status: 'present', pValue: minP, description: labels };
      }
      if (sub.every((s) => s.status === 'insufficient_data')) {
        return insufficient(name, displayName,
          'None of the underlying detectors have run with sufficient data');
      }
      return absent(name, displayName,
        sub.map((s) => s.description).filter(Boolean).join('; ') || 'No supporting evidence', null);
    },
  };
}

// ─── Atomic signal extractors ─────────────────────────────────────────────

/** Serial dependence — read directly from the revenge-trading detector
 *  (which already incorporates tilt-score behaviour and a chi-squared
 *  win-rate test on revenge vs normal trades). */
const sigSerialDependence: SignalDef = {
  name: 'serial_dependence',
  displayName: 'Serial dependence',
  extract(data) {
    const insight = findInsight(data.insights, 'revenge-trading');
    if (!insight) {
      return insufficient(this.name, this.displayName,
        'Revenge-trading detector has not run');
    }
    const d = insight.data ?? {};
    const revengeWinRate = typeof d.revengeWinRate === 'number' ? d.revengeWinRate : null;
    const normalWinRate  = typeof d.normalWinRate  === 'number' ? d.normalWinRate  : null;
    const totalRevengePnl = typeof d.totalRevengePnl === 'number' ? d.totalRevengePnl : null;
    const pValue = pickPrimaryPValue(insight);

    if (!insight.isSignificant) {
      return absent(this.name, this.displayName,
        'No significant clustering of post-loss trades', pValue);
    }
    // Significant + actually worse after losses (lower win rate or net negative)
    const worseAfterLoss =
      (revengeWinRate != null && normalWinRate != null && revengeWinRate < normalWinRate) ||
      (totalRevengePnl != null && totalRevengePnl < 0);
    if (!worseAfterLoss) {
      return absent(this.name, this.displayName,
        'Post-loss clustering present but does not underperform baseline', pValue);
    }
    const desc = revengeWinRate != null && normalWinRate != null
      ? `Post-loss win rate ${revengeWinRate}% vs ${normalWinRate}% baseline (p=${pValue?.toFixed(3) ?? '?'})`
      : `Revenge trading detected (p=${pValue?.toFixed(3) ?? '?'})`;
    return present(this.name, this.displayName, desc, pValue);
  },
};

/** Sizes increase after losses (martingale/revenge direction). */
const sigSizeUpAfterLoss: SignalDef = {
  name: 'size_up_after_loss',
  displayName: 'Size escalation after loss',
  extract(data) {
    const insight = findInsight(data.insights, 'size-escalation');
    if (!insight) return insufficient(this.name, this.displayName, 'Size-escalation detector has not run');
    const d = insight.data ?? {};
    const sizeDiffPct = typeof d.sizeDiffPct === 'number' ? d.sizeDiffPct : null;
    const pValue = pickPrimaryPValue(insight);
    if (sizeDiffPct == null) {
      return insufficient(this.name, this.displayName, 'Size differential not computed');
    }
    if (insight.isSignificant && sizeDiffPct > 10) {
      return present(this.name, this.displayName,
        `Average size after loss is ${sizeDiffPct}% larger than after a win (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Size differential ${sizeDiffPct}% — not in revenge direction`, pValue);
  },
};

/** Sizes increase after wins (overconfidence direction). The size-escalation
 *  detector tests post-loss vs post-win; sizeDiffPct < 0 means sizes are
 *  smaller after losses, equivalently larger after wins. */
const sigSizeUpAfterWin: SignalDef = {
  name: 'size_up_after_win',
  displayName: 'Size escalation after wins',
  extract(data) {
    const insight = findInsight(data.insights, 'size-escalation');
    if (!insight) return insufficient(this.name, this.displayName, 'Size-escalation detector has not run');
    const d = insight.data ?? {};
    const sizeDiffPct = typeof d.sizeDiffPct === 'number' ? d.sizeDiffPct : null;
    const pValue = pickPrimaryPValue(insight);
    if (sizeDiffPct == null) {
      return insufficient(this.name, this.displayName, 'Size differential not computed');
    }
    if (insight.isSignificant && sizeDiffPct < -10) {
      const inflation = Math.abs(sizeDiffPct);
      return present(this.name, this.displayName,
        `Average size after win is ${inflation}% larger than after a loss (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Size differential ${sizeDiffPct}% — not in overconfidence direction`, pValue);
  },
};

/** Sizes decrease after losses (fear direction). Same data as overconfidence:
 *  sizeDiffPct < 0 ⇒ post-loss < post-win. We treat them as the same signal
 *  but with separate names so the per-syndrome PDF checklist labels each
 *  syndrome's reading appropriately. */
const sigSizeDownAfterLoss: SignalDef = {
  name: 'size_down_after_loss',
  displayName: 'Size decrease after loss',
  extract(data) {
    const insight = findInsight(data.insights, 'size-escalation');
    if (!insight) return insufficient(this.name, this.displayName, 'Size-escalation detector has not run');
    const d = insight.data ?? {};
    const sizeDiffPct = typeof d.sizeDiffPct === 'number' ? d.sizeDiffPct : null;
    const pValue = pickPrimaryPValue(insight);
    if (sizeDiffPct == null) {
      return insufficient(this.name, this.displayName, 'Size differential not computed');
    }
    if (insight.isSignificant && sizeDiffPct < -10) {
      return present(this.name, this.displayName,
        `Position size shrinks ${Math.abs(sizeDiffPct)}% after a loss (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Sizes do not contract after losses (diff ${sizeDiffPct}%)`, pValue);
  },
};

/** Hold time shortens on losers vs winners (rapid-fire after a loss). The
 *  disposition detector measures avgLoserHold / avgWinnerHold; ratio < 1
 *  means losers held briefly relative to winners. Used as a fallback signal
 *  for the revenge-trader OR-group. */
const sigShortenedHoldAfterLoss: SignalDef = {
  name: 'shortened_hold_after_loss',
  displayName: 'Shortened hold time after loss',
  extract(data) {
    const insight = findInsight(data.insights, 'disposition');
    if (!insight) return insufficient(this.name, this.displayName, 'Disposition detector has not run');
    const d = insight.data ?? {};
    const ratio = typeof d.ratio === 'number' ? d.ratio : null;
    const pValue = pickPrimaryPValue(insight);
    if (ratio == null) return insufficient(this.name, this.displayName, 'Hold-time ratio not computed');
    if (insight.isSignificant && ratio < 0.85) {
      return present(this.name, this.displayName,
        `Losers held ${ratio.toFixed(2)}x as long as winners (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Loser/winner hold ratio ${ratio?.toFixed(2)} — losers not cut shorter`, pValue);
  },
};

/** Classic disposition effect — holding losers longer than winners. */
const sigDispositionPresent: SignalDef = {
  name: 'disposition_present',
  displayName: 'Disposition effect (classic)',
  extract(data) {
    const insight = findInsight(data.insights, 'disposition');
    if (!insight) return insufficient(this.name, this.displayName, 'Disposition detector has not run');
    const d = insight.data ?? {};
    const ratio = typeof d.ratio === 'number' ? d.ratio : null;
    const pValue = pickPrimaryPValue(insight);
    if (ratio == null) return insufficient(this.name, this.displayName, 'Hold-time ratio not computed');
    if (insight.isSignificant && ratio > 1.2) {
      return present(this.name, this.displayName,
        `Losers held ${ratio.toFixed(2)}x longer than winners (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `No significant classic disposition (ratio ${ratio.toFixed(2)})`, pValue);
  },
};

/** STRONG classic disposition — used as the contradicting signal for fear.
 *  Same direction as sigDispositionPresent but a higher threshold so a mild
 *  classic effect can co-exist with fear without contradicting it. */
const sigDispositionStronglyPresent: SignalDef = {
  name: 'disposition_strongly_present',
  displayName: 'Strong disposition effect',
  extract(data) {
    const insight = findInsight(data.insights, 'disposition');
    if (!insight) return insufficient(this.name, this.displayName, 'Disposition detector has not run');
    const d = insight.data ?? {};
    const ratio = typeof d.ratio === 'number' ? d.ratio : null;
    const pValue = pickPrimaryPValue(insight);
    if (ratio == null) return insufficient(this.name, this.displayName, 'Hold-time ratio not computed');
    if (insight.isSignificant && ratio >= 1.5) {
      return present(this.name, this.displayName,
        `Strong classic disposition — losers held ${ratio.toFixed(2)}x longer (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Classic disposition not strong (ratio ${ratio.toFixed(2)})`, pValue);
  },
};

/** At least one tilt episode triggered. */
const sigTiltEpisodes: SignalDef = {
  name: 'tilt_episodes',
  displayName: 'Tilt episodes triggered',
  extract(data) {
    const insight = findInsight(data.insights, 'tilt-episodes');
    if (!insight) return insufficient(this.name, this.displayName, 'Tilt-episode detector has not run');
    const d = insight.data ?? {};
    const totalEpisodes = typeof d.totalEpisodes === 'number' ? d.totalEpisodes : null;
    if (totalEpisodes == null) return insufficient(this.name, this.displayName, 'Episode count not available');
    const pValue = pickPrimaryPValue(insight);
    if (totalEpisodes > 0) {
      return present(this.name, this.displayName,
        `${totalEpisodes} tilt episode${totalEpisodes === 1 ? '' : 's'} detected`, pValue);
    }
    return absent(this.name, this.displayName, 'No tilt episodes detected', pValue);
  },
};

/** Tilt episodes increasing in frequency over time — compare first half vs
 *  second half of the tilt-episode timeline. */
const sigTiltEpisodesIncreasing: SignalDef = {
  name: 'tilt_episodes_increasing',
  displayName: 'Tilt episodes accelerating',
  extract(data) {
    const insight = findInsight(data.insights, 'tilt-episodes');
    if (!insight) return insufficient(this.name, this.displayName, 'Tilt-episode detector has not run');
    const eps = (insight.data?.episodes ?? []) as Array<{ startDate?: string | null }>;
    if (!Array.isArray(eps) || eps.length < 4) {
      return insufficient(this.name, this.displayName,
        'Need at least 4 tilt episodes to test for acceleration');
    }
    const dated = eps
      .map((e) => (e.startDate ? new Date(e.startDate).getTime() : null))
      .filter((t): t is number => t != null && !Number.isNaN(t))
      .sort((a, b) => a - b);
    if (dated.length < 4) {
      return insufficient(this.name, this.displayName, 'Episodes lack timestamps');
    }
    const midpoint = (dated[0] + dated[dated.length - 1]) / 2;
    const firstHalf  = dated.filter((t) => t <= midpoint).length;
    const secondHalf = dated.length - firstHalf;
    if (secondHalf > firstHalf) {
      return present(this.name, this.displayName,
        `${firstHalf} early episodes vs ${secondHalf} recent — frequency increasing`, null);
    }
    return absent(this.name, this.displayName,
      `${firstHalf} early episodes vs ${secondHalf} recent — not accelerating`, null);
  },
};

/** regime-mismatch contradicting heuristic for revenge trading: if regime
 *  performance differs significantly, attribute some of the loss-clustering
 *  to market conditions rather than behaviour. Acknowledged coarse proxy. */
const sigRegimeExplainsClustering: SignalDef = {
  name: 'regime_explains_clustering',
  displayName: 'Regime explains clustering',
  extract(data) {
    const insight = findInsight(data.insights, 'regime-mismatch');
    if (!insight) return insufficient(this.name, this.displayName, 'Regime-mismatch detector has not run');
    const pValue = pickPrimaryPValue(insight);
    if (insight.isSignificant) {
      return present(this.name, this.displayName,
        `Performance differs across regimes — some loss-clustering may be market-driven (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      'No significant regime performance differences', pValue);
  },
};

/** Performance degrades during winning streaks. */
const sigWinStreakDegrades: SignalDef = {
  name: 'win_streak_degrades',
  displayName: 'Win-streak degradation',
  extract(data) {
    const insight = findInsight(data.insights, 'streak-behavior');
    if (!insight) return insufficient(this.name, this.displayName, 'Streak-behaviour detector has not run');
    const d = insight.data ?? {};
    const winStreakWinRate = typeof d.winStreakWinRate === 'number' ? d.winStreakWinRate : null;
    const overallWinRate   = typeof d.overallWinRate   === 'number' ? d.overallWinRate   : null;
    const winStreakTotalPnl = typeof d.winStreakTotalPnl === 'number' ? d.winStreakTotalPnl : null;
    const winStreakCount = typeof d.winStreakCount === 'number' ? d.winStreakCount : 0;
    const pValue = pickPrimaryPValue(insight);

    if (winStreakCount < 2) {
      return insufficient(this.name, this.displayName,
        'Not enough win streaks observed to test for degradation');
    }
    const degrades =
      (winStreakWinRate != null && overallWinRate != null && winStreakWinRate < overallWinRate) ||
      (winStreakTotalPnl != null && winStreakTotalPnl < 0);
    if (insight.isSignificant && degrades) {
      const detail = winStreakWinRate != null && overallWinRate != null
        ? `Win-streak win rate ${winStreakWinRate}% vs ${overallWinRate}% overall`
        : `Win-streak total P&L $${winStreakTotalPnl?.toFixed(2)}`;
      return present(this.name, this.displayName, `${detail} (p=${pValue?.toFixed(3) ?? '?'})`, pValue);
    }
    return absent(this.name, this.displayName,
      'No significant win-streak performance degradation', pValue);
  },
};

/** Overtrading on heavy days. */
const sigOvertrading: SignalDef = {
  name: 'overtrading',
  displayName: 'Overtrading on heavy days',
  extract(data) {
    const insight = findInsight(data.insights, 'overtrading');
    if (!insight) return insufficient(this.name, this.displayName, 'Overtrading detector has not run');
    const d = insight.data ?? {};
    const heavy = typeof d.avgHeavyDayPnl === 'number' ? d.avgHeavyDayPnl : null;
    const light = typeof d.avgLightDayPnl === 'number' ? d.avgLightDayPnl : null;
    const pValue = pickPrimaryPValue(insight);
    if (heavy == null || light == null) {
      return insufficient(this.name, this.displayName, 'Heavy/light day P&L not computed');
    }
    if (insight.isSignificant && heavy < light) {
      return present(this.name, this.displayName,
        `Heavy days $${heavy.toFixed(2)} vs light days $${light.toFixed(2)} (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      'No significant overtrading penalty detected', pValue);
  },
};

/** Edge finder: large-size trades underperform small-size. The combinatorial
 *  search has no size dimension in its registered pairs, so this signal
 *  always resolves to insufficient_data — left here as a marker so the PDF
 *  checklist explains why it can't speak. */
const sigSizeUnderperforms: SignalDef = {
  name: 'large_size_underperforms',
  displayName: 'Large-size trades underperform',
  extract(data) {
    const insight = findInsight(data.insights, 'combinatorial-search');
    if (!insight) return insufficient(this.name, this.displayName, 'Combinatorial search has not run');
    return insufficient(this.name, this.displayName,
      'No size dimension in the registered slice search — cannot test size effect');
  },
};

/** Position-sizing CV is low — consistent sizing regardless of result. */
const sigSizingConsistent: SignalDef = {
  name: 'sizing_consistent',
  displayName: 'Consistent sizing',
  extract(data) {
    const insight = findInsight(data.insights, 'sizing-analysis');
    if (!insight) return insufficient(this.name, this.displayName, 'Sizing-analysis detector has not run');
    const d = insight.data ?? {};
    const cv = typeof d.cv === 'number' ? d.cv : null;
    if (cv == null) return insufficient(this.name, this.displayName, 'CV not computed');
    if (cv < 0.3) {
      return present(this.name, this.displayName,
        `Position-size CV ${cv.toFixed(2)} — sizing is highly consistent`, null);
    }
    return absent(this.name, this.displayName,
      `Position-size CV ${cv.toFixed(2)} — not strongly consistent`, null);
  },
};

/** Low exit efficiency on winners — cutting winners short. */
const sigLowExitEfficiency: SignalDef = {
  name: 'low_exit_efficiency',
  displayName: 'Low exit efficiency on winners',
  extract(data) {
    const insight = findInsight(data.insights, 'exit-optimizer');
    if (!insight) return insufficient(this.name, this.displayName, 'Exit-optimizer has not run');
    const d = insight.data ?? {};
    const eff = typeof d.avgEfficiency === 'number' ? d.avgEfficiency : null;
    const pValue = pickPrimaryPValue(insight);
    if (eff == null) return insufficient(this.name, this.displayName, 'Exit efficiency not computed');
    if (eff < 0.4) {
      return present(this.name, this.displayName,
        `Average exit efficiency ${(eff * 100).toFixed(1)}% — cutting winners well short of MFE`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Average exit efficiency ${(eff * 100).toFixed(1)}% — adequate winner capture`, pValue);
  },
};

/** Win rate after losses is higher than overall — suggests post-loss entries
 *  are actually fine; the issue is exits, not entries. */
const sigBetterEntriesAfterLoss: SignalDef = {
  name: 'better_entries_after_loss',
  displayName: 'Win rate after losses exceeds baseline',
  extract(data) {
    const insight = findInsight(data.insights, 'ml-patterns-markov');
    if (!insight) return insufficient(this.name, this.displayName, 'Markov analysis has not run');
    const markov = insight.data?.markov;
    if (!markov || !markov.transitionProbabilities) {
      return insufficient(this.name, this.displayName, 'Markov transition data not available');
    }
    const winAfterLoss = typeof markov.transitionProbabilities.winAfterLoss === 'number'
      ? markov.transitionProbabilities.winAfterLoss : null;
    const overallWinRate = typeof markov.overallWinRate === 'number' ? markov.overallWinRate : null;
    const pValue = pickPrimaryPValue(insight);
    if (winAfterLoss == null || overallWinRate == null) {
      return insufficient(this.name, this.displayName, 'Required transition probabilities missing');
    }
    if (winAfterLoss > overallWinRate + 0.02) {
      return present(this.name, this.displayName,
        `Win-after-loss ${(winAfterLoss * 100).toFixed(0)}% vs ${(overallWinRate * 100).toFixed(0)}% overall — entries fine, exits hurt you`,
        pValue);
    }
    return absent(this.name, this.displayName,
      `Win-after-loss ${(winAfterLoss * 100).toFixed(0)}% — not above baseline`, pValue);
  },
};

/** Session fatigue — performance decays with trade number in session. */
const sigSessionFatigue: SignalDef = {
  name: 'session_fatigue',
  displayName: 'Session fatigue',
  extract(data) {
    const insight = findInsight(data.insights, 'time-of-day-edge');
    if (!insight) return insufficient(this.name, this.displayName, 'Time-of-day-edge detector has not run');
    const fatigue = insight.data?.fatigue;
    if (!fatigue) return insufficient(this.name, this.displayName, 'Fatigue analysis not produced');
    const isSig = !!fatigue.isSignificant;
    const cutoff = typeof fatigue.optimalCutoff === 'number' ? fatigue.optimalCutoff : null;
    const pValue = pickPrimaryPValue(insight);
    if (isSig) {
      return present(this.name, this.displayName,
        `Performance decays after trade #${cutoff ?? '?'} (p=${pValue?.toFixed(3) ?? '?'})`,
        pValue);
    }
    return absent(this.name, this.displayName,
      'Within-session performance is stable', pValue);
  },
};

/** Session fatigue absent — used as the contradicting signal (negation of
 *  the required). Separate signal so the checklist labels it differently. */
const sigNoSessionFatigue: SignalDef = {
  name: 'no_session_fatigue',
  displayName: 'No session fatigue',
  extract(data) {
    const sig = sigSessionFatigue.extract(data);
    if (sig.status === 'insufficient_data') {
      return insufficient(this.name, this.displayName, sig.description);
    }
    if (sig.status === 'absent') {
      return present(this.name, this.displayName,
        'Performance is constant across session positions — no fatigue', sig.pValue);
    }
    return absent(this.name, this.displayName,
      'Session fatigue is detected (so this contradicting signal does not fire)', sig.pValue);
  },
};

/** Session fatigue cutoff exists — used in the fatigue OR-required.
 *  Distinct from the main session_fatigue signal because here we just need
 *  *some* cutoff (which the detector emits whenever fatigue.isSignificant). */
const sigFatigueCutoffExists: SignalDef = {
  name: 'fatigue_cutoff_exists',
  displayName: 'Session-fatigue cutoff suggested',
  extract(data) {
    const insight = findInsight(data.insights, 'time-of-day-edge');
    if (!insight) return insufficient(this.name, this.displayName, 'Time-of-day-edge detector has not run');
    const fatigue = insight.data?.fatigue;
    if (!fatigue) return insufficient(this.name, this.displayName, 'Fatigue analysis not produced');
    if (fatigue.isSignificant && typeof fatigue.optimalCutoff === 'number') {
      return present(this.name, this.displayName,
        `Suggested daily-trade cutoff at #${fatigue.optimalCutoff}`, pickPrimaryPValue(insight));
    }
    return absent(this.name, this.displayName, 'No session-fatigue cutoff produced', pickPrimaryPValue(insight));
  },
};

/** Walk-forward shows declining expectancy. */
const sigEdgeDeclining: SignalDef = {
  name: 'edge_declining',
  displayName: 'Edge persistence: declining',
  extract(data) {
    if (!data.walkForward) {
      return insufficient(this.name, this.displayName,
        'Walk-forward analysis unavailable — fewer than 30 trades');
    }
    if (data.walkForward.expectancyTrend === 'declining') {
      return present(this.name, this.displayName,
        `Walk-forward expectancy is declining (slope ${data.walkForward.expectancySlope.toFixed(3)})`, null);
    }
    return absent(this.name, this.displayName,
      `Walk-forward expectancy trend: ${data.walkForward.expectancyTrend}`, null);
  },
};

/** Walk-forward shows stable or improving — contradicting signal for
 *  discipline decay. */
const sigEdgeStableOrImproving: SignalDef = {
  name: 'edge_stable_or_improving',
  displayName: 'Edge persistence: stable or improving',
  extract(data) {
    if (!data.walkForward) {
      return insufficient(this.name, this.displayName,
        'Walk-forward analysis unavailable — fewer than 30 trades');
    }
    if (data.walkForward.expectancyTrend !== 'declining') {
      return present(this.name, this.displayName,
        `Expectancy trend ${data.walkForward.expectancyTrend} — edge holding`, null);
    }
    return absent(this.name, this.displayName, 'Expectancy trend is declining', null);
  },
};

/** Discipline (Shannon entropy) trend is declining — i.e. trading is
 *  becoming more scattered over time. */
const sigEntropyTrendDeclining: SignalDef = {
  name: 'entropy_trend_declining',
  displayName: 'Decision consistency declining',
  extract(data) {
    const insight = findInsight(data.insights, 'entropy');
    if (!insight) return insufficient(this.name, this.displayName, 'Entropy insight has not run');
    const trend = insight.data?.trend;
    if (typeof trend !== 'string') {
      return insufficient(this.name, this.displayName, 'Entropy trend not computed');
    }
    if (trend === 'declining') {
      return present(this.name, this.displayName,
        'Discipline score declining — trading is becoming more scattered', null);
    }
    return absent(this.name, this.displayName, `Discipline trend: ${trend}`, null);
  },
};

/** Sizing CV increasing over time — there is no rolling CV in the
 *  pipeline today, so this signal resolves to insufficient_data. */
const sigSizingCvIncreasing: SignalDef = {
  name: 'sizing_cv_increasing',
  displayName: 'Sizing volatility increasing',
  extract() {
    return insufficient(this.name, this.displayName,
      'Rolling sizing CV is not tracked — cannot determine trend');
  },
};

/** Playbook adherence declining — no playbook tracking in the pipeline. */
const sigPlaybookAdherenceDeclining: SignalDef = {
  name: 'playbook_adherence_declining',
  displayName: 'Playbook adherence declining',
  extract() {
    return insufficient(this.name, this.displayName,
      'Playbook adherence tracking is not implemented');
  },
};

/** regime-mismatch significant — first required of regime blindness. */
const sigRegimeMismatchSignificant: SignalDef = {
  name: 'regime_mismatch_significant',
  displayName: 'Performance differs across regimes',
  extract(data) {
    const insight = findInsight(data.insights, 'regime-mismatch');
    if (!insight) return insufficient(this.name, this.displayName, 'Regime-mismatch detector has not run');
    const pValue = pickPrimaryPValue(insight);
    if (insight.isSignificant) {
      return present(this.name, this.displayName,
        `Significant performance gap across regimes (p=${pValue?.toFixed(3) ?? '?'})`, pValue);
    }
    return absent(this.name, this.displayName,
      'No significant regime performance gap detected', pValue);
  },
};

/** No evidence of strategy adaptation: the combinatorial search did NOT
 *  surface a significant regime × tradeType slice. PRESENT means "no
 *  adaptation", which is the required signal for regime blindness. */
const sigNoStrategyAdaptation: SignalDef = {
  name: 'no_strategy_adaptation',
  displayName: 'No regime × strategy adaptation',
  extract(data) {
    const insight = findInsight(data.insights, 'combinatorial-search');
    if (!insight) return insufficient(this.name, this.displayName, 'Combinatorial search has not run');
    const findings = insight.data?.combinatorial?.findings as Array<{ dimensions?: Array<{ name: string }> }> | undefined;
    if (!Array.isArray(findings)) {
      return insufficient(this.name, this.displayName, 'No findings array on combinatorial search');
    }
    const adapted = findings.some((f) => {
      const dims = (f.dimensions ?? []).map((d) => d.name);
      return dims.includes('regime') && dims.includes('tradeType');
    });
    if (!adapted) {
      return present(this.name, this.displayName,
        'No surviving regime × tradeType slice — same approach across conditions', null);
    }
    return absent(this.name, this.displayName,
      'Edge finder shows trade type performance differs by regime — trader is adapting', null);
  },
};

/** Strategy IS adapting — the inverse of the above; contradicts regime
 *  blindness. */
const sigStrategyAdapting: SignalDef = {
  name: 'strategy_adapting',
  displayName: 'Trade-type mix changes with regime',
  extract(data) {
    const sig = sigNoStrategyAdaptation.extract(data);
    if (sig.status === 'insufficient_data') {
      return insufficient(this.name, this.displayName, sig.description);
    }
    if (sig.status === 'absent') {
      return present(this.name, this.displayName,
        'Trade-type mix shifts significantly across regimes', sig.pValue);
    }
    return absent(this.name, this.displayName,
      'No significant regime × tradeType variation detected', sig.pValue);
  },
};

/** Worst regime accounts for >50% of total losses. */
const sigWorstRegimeDominantLoss: SignalDef = {
  name: 'worst_regime_dominant_loss',
  displayName: 'Worst regime concentrates losses',
  extract(data) {
    const rb = data.regimeBreakdown ?? {};
    const entries = Object.entries(rb);
    if (entries.length < 2) {
      return insufficient(this.name, this.displayName, 'Need at least two regimes to compare');
    }
    let totalLosses = 0;
    let worstLoss = 0;
    let worstName = '';
    for (const [name, stats] of entries) {
      const total = typeof stats?.totalPnl === 'number' ? stats.totalPnl : 0;
      if (total < 0) {
        totalLosses += -total;
        if (-total > worstLoss) {
          worstLoss = -total;
          worstName = name;
        }
      }
    }
    if (totalLosses <= 0) {
      return absent(this.name, this.displayName, 'No net losing regimes', null);
    }
    const share = worstLoss / totalLosses;
    if (share > 0.5) {
      return present(this.name, this.displayName,
        `${worstName} regime accounts for ${(share * 100).toFixed(0)}% of total losses`, null);
    }
    return absent(this.name, this.displayName,
      `Worst-regime loss share ${(share * 100).toFixed(0)}% — losses are spread across regimes`, null);
  },
};

/** Transitional regime has significantly negative expectancy. */
const sigTransitionalLossesElevated: SignalDef = {
  name: 'transitional_losses_elevated',
  displayName: 'Transitional regime losing',
  extract(data) {
    const stats = data.regimeBreakdown?.transitional;
    if (!stats) {
      return insufficient(this.name, this.displayName, 'No transitional-regime data');
    }
    const expectancy = typeof stats.expectancy === 'number' ? stats.expectancy : null;
    const pnlPValue  = typeof stats.pnlPValue === 'number' ? stats.pnlPValue : null;
    if (expectancy == null) {
      return insufficient(this.name, this.displayName, 'No expectancy for transitional regime');
    }
    const sigSlice = pnlPValue != null && pnlPValue < 0.05;
    if (expectancy < 0 && sigSlice) {
      return present(this.name, this.displayName,
        `Transitional regime expectancy $${expectancy.toFixed(2)} (p=${pnlPValue?.toFixed(3)})`, pnlPValue);
    }
    return absent(this.name, this.displayName,
      `Transitional expectancy $${expectancy.toFixed(2)} — not significantly negative`, pnlPValue);
  },
};

// ─── Syndrome definitions ────────────────────────────────────────────────

export const SYNDROMES: SyndromeDef[] = [
  {
    name: 'revenge_trading',
    displayName: 'Revenge Trading',
    required: [
      sigSerialDependence,
      compositeOr('post_loss_behaviour_shift', 'Post-loss behavioural shift', [
        sigSizeUpAfterLoss,
        sigShortenedHoldAfterLoss,
      ]),
    ],
    supporting: [sigDispositionPresent, sigTiltEpisodes],
    contradicting: [sigRegimeExplainsClustering],
    intervention(data) {
      const insight = findInsight(data.insights, 'revenge-trading');
      const d = insight?.data ?? {};
      const x = typeof d.revengeWinRate === 'number' ? `${d.revengeWinRate}%` : 'lower';
      const y = typeof d.normalWinRate  === 'number' ? `${d.normalWinRate}%`  : 'baseline';
      return `Set a mandatory cooldown after 2 consecutive losses. Your data shows your win rate drops to ${x} after a loss vs ${y} after a win.`;
    },
  },
  {
    name: 'overconfidence',
    displayName: 'Overconfidence',
    required: [sigSizeUpAfterWin, sigWinStreakDegrades],
    supporting: [sigOvertrading, sigSizeUnderperforms],
    contradicting: [sigSizingConsistent],
    intervention() {
      return 'Your sizing increases after wins but later trades in winning streaks underperform. Lock position size to a fixed fraction — your edge is in selection, not conviction scaling.';
    },
  },
  {
    name: 'fear_hesitation',
    displayName: 'Fear / Hesitation',
    required: [sigSizeDownAfterLoss, sigLowExitEfficiency],
    supporting: [sigShortenedHoldAfterLoss, sigBetterEntriesAfterLoss],
    contradicting: [sigDispositionStronglyPresent],
    intervention() {
      return 'After losses you trade smaller and exit winners faster. Your entries after losses are actually better — the problem is you do not let them run. Consider mechanical take-profit targets.';
    },
  },
  {
    name: 'fatigue_decay',
    displayName: 'Fatigue / Decay',
    required: [
      sigSessionFatigue,
      compositeOr('overtrading_or_cutoff', 'Overtrading or fatigue cutoff', [
        sigOvertrading,
        sigFatigueCutoffExists,
      ]),
    ],
    supporting: [sigEdgeDeclining, sigEntropyTrendDeclining],
    contradicting: [sigNoSessionFatigue],
    intervention(data) {
      const insight = findInsight(data.insights, 'time-of-day-edge');
      const cutoff = insight?.data?.fatigue?.optimalCutoff;
      const n = typeof cutoff === 'number' ? cutoff : '?';
      return `Your performance peaks at trade #${n}. After that, your win rate drops. Set a hard daily trade limit or take a mandatory break.`;
    },
  },
  {
    name: 'regime_blindness',
    displayName: 'Regime Blindness',
    required: [sigRegimeMismatchSignificant, sigNoStrategyAdaptation],
    supporting: [sigWorstRegimeDominantLoss, sigTransitionalLossesElevated],
    contradicting: [sigStrategyAdapting],
    intervention(data) {
      const rb = data.regimeBreakdown ?? {};
      const entries = Object.entries(rb)
        .filter(([, s]) => typeof s?.winRate === 'number' && typeof s?.tradeCount === 'number' && s.tradeCount >= 5);
      if (entries.length < 2) {
        return 'You use the same approach regardless of market conditions. Reduce size or stop trading when market regime shifts.';
      }
      entries.sort(([, a], [, b]) => (b.winRate as number) - (a.winRate as number));
      const best = entries[0];
      const worst = entries[entries.length - 1];
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      return `You use the same approach regardless of market conditions. Your win rate is ${pct(best[1].winRate as number)} in ${best[0]} but ${pct(worst[1].winRate as number)} in ${worst[0]}. Reduce size or stop trading when market regime shifts.`;
    },
  },
  {
    name: 'discipline_decay',
    displayName: 'Discipline Decay',
    required: [
      sigEdgeDeclining,
      compositeOr('discipline_drift', 'Discipline drift', [
        sigEntropyTrendDeclining,
        sigSizingCvIncreasing,
      ]),
    ],
    supporting: [sigPlaybookAdherenceDeclining, sigTiltEpisodesIncreasing],
    contradicting: [sigEdgeStableOrImproving],
    intervention() {
      return 'Your trading is becoming more scattered over time. Return to your core setups — your early focus produced better results.';
    },
  },
];
