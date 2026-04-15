import 'server-only';

/**
 * Convergence detection — meta-analysis layer.
 *
 * Reads the existing analytics outputs (summary, stored insights, what-if,
 * walk-forward) and finds themes where multiple independent signals point at
 * the same underlying problem (or strength). The goal is to move the UX from
 * "here are your charts" to "here is the one thing that's costing you the
 * most money, and here is what to do about it."
 *
 * This module intentionally issues no new database queries of its own — it
 * composes results that other parts of the analytics stack already compute.
 * Every theme check is guarded: if a required signal is missing (e.g. MFE
 * data hasn't been computed, or the user has no insights yet), that theme
 * simply doesn't fire. The rest still can.
 */

import { prisma } from '@/lib/prisma';
import { createAnalyticsService } from './index';
import { computeWhatIfCurves, type WhatIfCurvesResult } from './what-if-curves';
import { computeWalkForward, type WalkForwardResult } from './walk-forward';
import type { Insight } from './types';
import type { AdvancedSummary } from './analytics-service';

// ─── Public types ──────────────────────────────────────────────────────────

export type ThemeId =
  | 'exit_weakness'
  | 'session_fatigue'
  | 'regime_mismatch'
  | 'risk_management'
  | 'information_quality'
  | 'strength';

export type ThemeSeverity = 'critical' | 'warning' | 'positive' | 'info';

export type TabLink = 'execution' | 'psychology' | 'strategy' | 'risk' | 'insights';

export interface ConvergentTheme {
  id: string;
  theme: ThemeId;
  severity: ThemeSeverity;

  headline: string;
  diagnosis: string;
  evidence: string[];
  prescription: string;
  expectedImpact: string;

  supportingInsightIds: string[];
  convergenceStrength: number;  // how many independent signals agreed (2–5)
  priority: number;             // actionability × avgConfidence × log(1+|$impact|)

  tabLink: TabLink;
}

export interface ConvergenceResult {
  themes: ConvergentTheme[];
  biggestLeak: ConvergentTheme | null;
  biggestStrength: ConvergentTheme | null;
  weeklyFocus: ConvergentTheme | null;
  tradeCount: number;
  insufficientData: boolean;
}

// ─── Configuration ─────────────────────────────────────────────────────────

const MIN_TRADES = 15;

const ACTIONABILITY: Record<ThemeId, number> = {
  session_fatigue:     0.9,
  regime_mismatch:     0.8,
  risk_management:     0.7,
  exit_weakness:       0.6,
  information_quality: 0.5,
  strength:            0.3,
};

// ─── Main entry point ──────────────────────────────────────────────────────

export async function detectConvergentThemes(
  walletAddress: string,
  journalId?: string,
): Promise<ConvergenceResult> {
  const service = createAnalyticsService();
  const filters = journalId ? { journalId } : undefined;

  const summary = await service.getAdvancedSummary(walletAddress, filters);
  const tradeCount = summary.performance.data.tradeCount ?? 0;

  if (tradeCount < MIN_TRADES) {
    return {
      themes: [],
      biggestLeak: null,
      biggestStrength: null,
      weeklyFocus: null,
      tradeCount,
      insufficientData: true,
    };
  }

  const [insightsResult, whatIf, walkForward] = await Promise.all([
    service.getStoredInsights(walletAddress, journalId),
    computeWhatIfCurves(prisma as any, walletAddress, journalId),
    computeWalkForward(prisma as any, walletAddress, journalId),
  ]);

  const insights = insightsResult.insights;

  const themes: ConvergentTheme[] = [];
  pushIfPresent(themes, detectExitWeakness(summary, insights, whatIf));
  pushIfPresent(themes, detectSessionFatigue(insights));
  pushIfPresent(themes, detectRegimeMismatch(summary, whatIf));
  pushIfPresent(themes, detectRiskManagement(summary, insights));
  pushIfPresent(themes, detectStrength(summary, walkForward, insights));
  pushIfPresent(themes, detectInformationQuality(summary, insights));

  themes.sort((a, b) => b.priority - a.priority);

  const negatives = themes.filter(
    (t) => t.severity === 'critical' || t.severity === 'warning',
  );
  const positives = themes.filter((t) => t.severity === 'positive');

  const biggestLeak = negatives[0] ?? null;
  const biggestStrength = positives[0] ?? null;
  const weeklyFocus =
    [...negatives].sort(
      (a, b) => ACTIONABILITY[b.theme] - ACTIONABILITY[a.theme],
    )[0] ?? null;

  return {
    themes,
    biggestLeak,
    biggestStrength,
    weeklyFocus,
    tradeCount,
    insufficientData: false,
  };
}

// ─── Theme: exit_weakness ──────────────────────────────────────────────────

function detectExitWeakness(
  summary: AdvancedSummary,
  insights: Insight[],
  whatIf: WhatIfCurvesResult,
): ConvergentTheme | null {
  const exitInsight = findInsight(insights, 'exit-optimizer');
  const dispo = findInsight(insights, 'disposition');

  const exitEfficiency =
    numberOrNull(exitInsight?.data.avgEfficiency) ??
    numberOrNull(whatIf.avgExitEfficiency);
  const hasLowExit = exitEfficiency != null && exitEfficiency < 0.4;

  const dispoRatio = numberOrNull(dispo?.data.ratio); // loserHold / winnerHold
  const hasDisposition = dispoRatio != null && dispoRatio > 1;

  const optimalExitDelta = numberOrNull(whatIf.exitMoneyLeftOnTable);
  const hasWhatIfGain = optimalExitDelta != null && optimalExitDelta > 1000;

  const signalCount = [hasLowExit, hasDisposition, hasWhatIfGain].filter(
    Boolean,
  ).length;

  if (!hasLowExit || signalCount < 2) return null;

  const winnerHold = numberOrNull(dispo?.data.avgWinnerHoldSeconds);
  const loserHold = numberOrNull(dispo?.data.avgLoserHoldSeconds);

  const leak =
    optimalExitDelta != null && optimalExitDelta > 0
      ? optimalExitDelta
      : null;
  const headline =
    leak != null
      ? `Your exits are costing you ${formatMoney(leak)}`
      : 'Your exits are cutting winners too early';

  const effPct = exitEfficiency != null ? Math.round(exitEfficiency * 100) : null;

  const evidence: string[] = [];
  if (effPct != null) evidence.push(`Exit efficiency: ${effPct}%`);
  if (dispoRatio != null) evidence.push(`Disposition ratio: ${dispoRatio.toFixed(2)}× (losers held longer)`);
  if (winnerHold != null && loserHold != null) {
    evidence.push(`Winners held ${formatDuration(winnerHold)}, losers ${formatDuration(loserHold)}`);
  }
  if (optimalExitDelta != null) {
    evidence.push(`What-if optimal exits: +${formatMoney(optimalExitDelta)} vs actual`);
  }

  const diagnosisParts: string[] = [];
  if (effPct != null) {
    diagnosisParts.push(
      `You consistently exit winning trades too early, capturing only ${effPct}% of available profit.`,
    );
  } else {
    diagnosisParts.push('You consistently exit winning trades before the move is done.');
  }
  if (winnerHold != null && loserHold != null && loserHold > winnerHold) {
    diagnosisParts.push(
      `Your hold time for winners (${formatDuration(winnerHold)}) is shorter than for losers (${formatDuration(loserHold)}), suggesting you take profits from fear rather than letting your edge play out.`,
    );
  }
  const diagnosis = diagnosisParts.join(' ');

  const prescription =
    'Try holding winners 10% longer as an experiment this week. Your MFE data shows price typically moves in your favor well past where you exit.';

  const realisticImprovement = leak != null ? leak * 0.1 : null;
  const expectedImpact =
    realisticImprovement != null
      ? `A 10% improvement in exit timing would add approximately ${formatMoney(realisticImprovement)}.`
      : 'Even small improvements in exit timing compound across your trade count.';

  const severity: ThemeSeverity =
    leak != null && leak > 5000 ? 'critical' : 'warning';

  const supporting = supportingIds([exitInsight, dispo]);
  const dollarImpact = leak ?? (dispo?.data?.estimatedCost as number | undefined) ?? 500;
  const confidence = avgConfidence([exitInsight, dispo]);

  return {
    id: 'exit_weakness',
    theme: 'exit_weakness',
    severity,
    headline,
    diagnosis,
    evidence,
    prescription,
    expectedImpact,
    supportingInsightIds: supporting,
    convergenceStrength: signalCount,
    priority: priorityFor('exit_weakness', confidence, dollarImpact),
    tabLink: 'execution',
  };
}

// ─── Theme: session_fatigue ────────────────────────────────────────────────

function detectSessionFatigue(insights: Insight[]): ConvergentTheme | null {
  const timeOfDay = findInsight(insights, 'time-of-day-edge');
  const tilt = findInsight(insights, 'tilt-episodes');
  const escalation = findInsight(insights, 'size-escalation');

  const fatigue = timeOfDay?.data.fatigue as
    | {
        optimalCutoff: number;
        earlyAvg: number;
        lateAvg: number;
        estimatedSavings: number;
      }
    | null
    | undefined;

  const hasFatigue = fatigue != null && typeof fatigue.estimatedSavings === 'number';
  const fatigueCost = hasFatigue ? Math.max(0, fatigue!.estimatedSavings) : 0;
  const hasFatigueHighImpact = hasFatigue && fatigueCost > 100;

  const tiltEpisodes = numberOrNull(tilt?.data.totalEpisodes) ?? 0;
  const tiltCost = Math.max(
    0,
    numberOrNull(tilt?.data.counterfactualImprovement) ?? 0,
  );
  const hasTilt = tiltEpisodes > 0;
  const hasTiltSignificant = tiltEpisodes > 2 && tiltCost > 500;

  const hasEscalation = escalation?.isSignificant === true;

  const allThree = hasFatigue && hasTilt && hasEscalation;
  const fatigueAlone = hasFatigueHighImpact;
  const tiltAlone = hasTiltSignificant;

  if (!allThree && !fatigueAlone && !tiltAlone) return null;

  const totalCost = fatigueCost + tiltCost;
  const optimalStop = hasFatigue ? fatigue!.optimalCutoff : null;

  const headline =
    totalCost > 0
      ? `Session fatigue is costing you ${formatMoney(totalCost)}`
      : 'Session fatigue is eroding your performance';

  const evidence: string[] = [];
  if (hasFatigue) {
    evidence.push(
      `Performance drops after trade #${fatigue!.optimalCutoff} (${formatMoney(fatigue!.earlyAvg)} early vs ${formatMoney(fatigue!.lateAvg)} late)`,
    );
  }
  if (hasTilt) {
    evidence.push(
      `${tiltEpisodes} tilt episode${tiltEpisodes === 1 ? '' : 's'} detected, costing ~${formatMoney(tiltCost)}`,
    );
  }
  if (hasEscalation) evidence.push('Position size escalates after losses');

  const diagnosisPieces: string[] = [];
  if (allThree) {
    diagnosisPieces.push('Three signals point to the same issue.');
  }
  if (optimalStop != null) {
    diagnosisPieces.push(`Your trading deteriorates after trade #${optimalStop} in a session.`);
  } else if (hasTilt) {
    diagnosisPieces.push('Tilt episodes cluster around losses and spread into the trades that follow.');
  }
  const diagnosis = diagnosisPieces.join(' ');

  const prescription = optimalStop != null
    ? `Set a hard session limit of ${optimalStop} trades, or take a 30-minute break before continuing.`
    : 'Set a session limit and step away after consecutive losses before sizing up.';

  const savingsPerSession =
    hasFatigue && optimalStop != null
      ? fatigueCost / Math.max(1, optimalStop)
      : null;
  const expectedImpact =
    savingsPerSession != null
      ? `Stopping at trade #${optimalStop} would save approximately ${formatMoney(savingsPerSession)} per session.`
      : totalCost > 0
        ? `Avoiding tilt-state trading would recover approximately ${formatMoney(totalCost)}.`
        : 'Capping sessions keeps drawdowns from compounding.';

  const supporting = supportingIds([timeOfDay, tilt, escalation]);
  const confidence = avgConfidence([timeOfDay, tilt, escalation]);
  const signalCount = [hasFatigue, hasTilt, hasEscalation].filter(Boolean).length;

  return {
    id: 'session_fatigue',
    theme: 'session_fatigue',
    severity: 'warning',
    headline,
    diagnosis,
    evidence,
    prescription,
    expectedImpact,
    supportingInsightIds: supporting,
    convergenceStrength: signalCount,
    priority: priorityFor('session_fatigue', confidence, totalCost || 500),
    tabLink: 'psychology',
  };
}

// ─── Theme: regime_mismatch ────────────────────────────────────────────────

function detectRegimeMismatch(
  summary: AdvancedSummary,
  whatIf: WhatIfCurvesResult,
): ConvergentTheme | null {
  const regimeMap =
    (summary.performance.breakdowns?.regime as Record<string, any>) ?? {};

  const qualifying = Object.entries(regimeMap).filter(
    ([name, stats]) =>
      name !== 'unknown' &&
      typeof stats?.tradeCount === 'number' &&
      stats.tradeCount >= 5,
  );
  if (qualifying.length < 2) return null;

  const sorted = [...qualifying].sort(
    ([, a], [, b]) => (a.winRate ?? 0) - (b.winRate ?? 0),
  );
  const [worstRegime, worst] = sorted[0];
  const [bestRegime, best] = sorted[sorted.length - 1];

  const bestTotalPnl = numberOrZero(best.totalPnl);
  const worstTotalPnl = numberOrZero(worst.totalPnl);
  const bestWinRate = numberOrZero(best.winRate);
  const worstWinRate = numberOrZero(worst.winRate);

  const oneNegativeRestPositive = worstTotalPnl < 0 && bestTotalPnl > 0;
  const winRateGap = Math.abs(bestWinRate - worstWinRate) > 0.10;

  if (!oneNegativeRestPositive && !winRateGap) return null;

  const bestLabel = formatRegime(bestRegime);
  const worstLabel = formatRegime(worstRegime);
  const bestWRPct = Math.round(bestWinRate * 100);
  const worstWRPct = Math.round(worstWinRate * 100);

  const headline = `You lose money in ${worstLabel} markets`;
  const diagnosis =
    `Your strategy works well in ${bestLabel} (${bestWRPct}% win rate) but fails in ` +
    `${worstLabel} (${worstWRPct}% win rate).`;

  const evidence: string[] = [
    `${bestLabel}: ${bestWRPct}% win rate, total ${formatMoney(bestTotalPnl)}`,
    `${worstLabel}: ${worstWRPct}% win rate, total ${formatMoney(worstTotalPnl)}`,
  ];

  const regimeFilterImprovement = numberOrNull(whatIf.regimeFilterImprovement);
  if (regimeFilterImprovement != null && regimeFilterImprovement > 0) {
    evidence.push(
      `Skipping the worst regime recovers ~${formatMoney(regimeFilterImprovement)}`,
    );
  }

  const prescription = `Reduce size by 50% or avoid trading entirely during ${worstLabel} periods.`;

  const expectedImpact =
    regimeFilterImprovement != null && regimeFilterImprovement > 0
      ? `Skipping ${worstLabel} trades would have saved ${formatMoney(regimeFilterImprovement)}.`
      : `Losses in ${worstLabel} total ${formatMoney(Math.abs(worstTotalPnl))} so far.`;

  const dollarImpact =
    regimeFilterImprovement != null && regimeFilterImprovement > 0
      ? regimeFilterImprovement
      : Math.abs(worstTotalPnl);

  const signals =
    (oneNegativeRestPositive ? 1 : 0) +
    (winRateGap ? 1 : 0) +
    (regimeFilterImprovement != null && regimeFilterImprovement > 0 ? 1 : 0);

  return {
    id: 'regime_mismatch',
    theme: 'regime_mismatch',
    severity: 'warning',
    headline,
    diagnosis,
    evidence,
    prescription,
    expectedImpact,
    supportingInsightIds: [],
    convergenceStrength: Math.max(2, signals),
    priority: priorityFor('regime_mismatch', 0.7, dollarImpact),
    tabLink: 'strategy',
  };
}

// ─── Theme: risk_management ────────────────────────────────────────────────

function detectRiskManagement(
  summary: AdvancedSummary,
  insights: Insight[],
): ConvergentTheme | null {
  const rm = summary.riskMetrics;
  const sizingInsight = findInsight(insights, 'sizing-analysis');
  const liquidationInsight = findInsight(insights, 'liquidation');

  const cv = numberOrNull(sizingInsight?.data.cv);
  const highCv = cv != null && cv > 5;

  const liqCount = numberOrNull(liquidationInsight?.data.liquidationCount) ?? 0;
  const liqCost = Math.abs(numberOrNull(liquidationInsight?.data.totalCost) ?? 0);
  const hasLiquidations = liqCount > 0;

  const sharpe = rm.sharpeRatio;
  const lowSharpe = sharpe != null && sharpe < 0.3;

  const payoff = rm.payoffRatio;
  const lowPayoff = payoff != null && payoff < 1.0;

  const dd = rm.drawdownAnalysis;
  const elevatedDrawdown =
    dd.avgDrawdownDuration > 0 &&
    dd.currentDrawdownDuration > dd.avgDrawdownDuration * 1.5;

  const signalCount = [
    highCv,
    hasLiquidations,
    lowSharpe,
    lowPayoff,
    elevatedDrawdown,
  ].filter(Boolean).length;

  if (signalCount === 0) return null;

  const severity: ThemeSeverity = hasLiquidations ? 'critical' : 'warning';

  const headline = hasLiquidations
    ? `You were liquidated ${liqCount} time${liqCount === 1 ? '' : 's'}, costing ${formatMoney(liqCost)}`
    : 'Your risk management needs attention';

  const evidence: string[] = [];
  if (hasLiquidations) evidence.push(`Liquidations: ${liqCount} (cost ${formatMoney(liqCost)})`);
  if (lowSharpe && sharpe != null) evidence.push(`Sharpe ratio: ${sharpe.toFixed(2)} (below 0.3)`);
  if (lowPayoff && payoff != null) evidence.push(`Payoff ratio: ${payoff.toFixed(2)} (avg loss ≥ avg win)`);
  if (highCv && cv != null) evidence.push(`Position-size CV: ${cv.toFixed(2)} (highly variable)`);
  if (elevatedDrawdown) {
    evidence.push(
      `Current drawdown ${Math.round(dd.currentDrawdownDuration)}d vs avg ${Math.round(dd.avgDrawdownDuration)}d`,
    );
  }

  const diagnosisParts: string[] = [];
  if (hasLiquidations) {
    diagnosisParts.push('Forced closures mean leverage overwhelmed your margin buffer.');
  }
  if (lowPayoff) diagnosisParts.push('Your average loss is larger than your average win, so even a decent win rate loses money.');
  if (lowSharpe) diagnosisParts.push('Risk-adjusted returns are low relative to the volatility of your P&L.');
  if (highCv) diagnosisParts.push('Position sizing is highly variable, suggesting discretionary sizing rather than a rule.');
  if (elevatedDrawdown) diagnosisParts.push('The current drawdown has already exceeded your typical recovery time.');
  const diagnosis = diagnosisParts.join(' ');

  const prescriptions: string[] = [];
  if (hasLiquidations) prescriptions.push('Reduce leverage and set stops on every trade.');
  if (highCv) prescriptions.push('Adopt fixed-fractional sizing to remove ad-hoc size decisions.');
  if (lowPayoff) prescriptions.push('Widen targets or tighten stops until average win > average loss.');
  if (!prescriptions.length) prescriptions.push('Tighten position-size rules and review stop placement.');
  const prescription = prescriptions.join(' ');

  const dollarImpact = hasLiquidations ? liqCost : Math.max(500, Math.abs(dd.maxDrawdown));
  const expectedImpact = hasLiquidations
    ? `Avoiding forced closures preserves ~${formatMoney(liqCost)} and protects the account.`
    : `Reining in drawdown duration keeps equity high-water-marks recoverable sooner.`;

  return {
    id: 'risk_management',
    theme: 'risk_management',
    severity,
    headline,
    diagnosis,
    evidence,
    prescription,
    expectedImpact,
    supportingInsightIds: supportingIds([sizingInsight, liquidationInsight]),
    convergenceStrength: signalCount,
    priority: priorityFor(
      'risk_management',
      avgConfidence([sizingInsight, liquidationInsight]) || 0.8,
      dollarImpact,
    ),
    tabLink: 'risk',
  };
}

// ─── Theme: strength ───────────────────────────────────────────────────────

function detectStrength(
  summary: AdvancedSummary,
  walkForward: WalkForwardResult | null,
  insights: Insight[],
): ConvergentTheme | null {
  const regimeMap =
    (summary.performance.breakdowns?.regime as Record<string, any>) ?? {};

  const qualifying = Object.entries(regimeMap).filter(
    ([name, stats]) =>
      name !== 'unknown' &&
      typeof stats?.tradeCount === 'number' &&
      stats.tradeCount >= 5 &&
      numberOrZero(stats.expectancy) > 0,
  );

  const sortedByExpectancy = [...qualifying].sort(
    ([, a], [, b]) => numberOrZero(b.expectancy) - numberOrZero(a.expectancy),
  );
  const best = sortedByExpectancy[0];

  const wfTrend =
    walkForward?.expectancyTrend === 'improving' ||
    walkForward?.expectancyTrend === 'stable' ||
    walkForward?.edgePersistent === true;

  if (!best && !wfTrend) return null;

  let bestRegimeLabel: string | null = null;
  let bestWinRatePct: number | null = null;
  let bestExpectancy: number | null = null;
  if (best) {
    const [name, stats] = best;
    bestRegimeLabel = formatRegime(name);
    bestWinRatePct = Math.round(numberOrZero(stats.winRate) * 100);
    bestExpectancy = numberOrZero(stats.expectancy);
  }

  const area = bestRegimeLabel ?? 'recent';
  const headline = `Your ${area} trading is strong`;

  const diagnosisParts: string[] = [];
  if (bestRegimeLabel && bestWinRatePct != null && bestExpectancy != null) {
    diagnosisParts.push(
      `You perform well in ${bestRegimeLabel} conditions. Your win rate of ${bestWinRatePct}% and expectancy of ${formatMoney(bestExpectancy)} per trade in these conditions significantly exceeds your baseline.`,
    );
  }
  if (walkForward?.expectancyTrend === 'improving') {
    diagnosisParts.push('Walk-forward windows show expectancy improving over time.');
  } else if (walkForward?.edgePersistent) {
    diagnosisParts.push('Walk-forward windows show your edge is durable across periods.');
  }
  const diagnosis = diagnosisParts.join(' ');

  const evidence: string[] = [];
  if (best) {
    const [, stats] = best;
    evidence.push(`Best regime expectancy: ${formatMoney(numberOrZero(stats.expectancy))} per trade`);
    evidence.push(`${bestRegimeLabel} win rate: ${bestWinRatePct}%`);
  }
  if (walkForward?.expectancyTrend) {
    evidence.push(`Walk-forward expectancy trend: ${walkForward.expectancyTrend}`);
  }

  const prescription =
    bestRegimeLabel != null
      ? `Lean into ${bestRegimeLabel} setups — size them full and skip conditions outside this regime.`
      : 'Keep doing what is working in your most recent windows and resist changing your approach.';

  const expectedImpact =
    bestExpectancy != null
      ? `Replicating this expectancy across more trades compounds meaningfully.`
      : 'Your current edge is holding — protect it before adding complexity.';

  const supporting = supportingIds([
    findInsight(insights, 'wart'),
    findInsight(insights, 'regime-mismatch'),
  ]);

  return {
    id: 'strength',
    theme: 'strength',
    severity: 'positive',
    headline,
    diagnosis,
    evidence,
    prescription,
    expectedImpact,
    supportingInsightIds: supporting,
    convergenceStrength: Math.max(1, [best, wfTrend].filter(Boolean).length),
    priority: priorityFor('strength', 0.7, Math.max(100, bestExpectancy ?? 100)),
    tabLink: 'strategy',
  };
}

// ─── Theme: information_quality ────────────────────────────────────────────

function detectInformationQuality(
  summary: AdvancedSummary,
  insights: Insight[],
): ConvergentTheme | null {
  const social = findInsight(insights, 'social-correlation');
  const socialWorseBucket = social?.data.betterGroup === 'low';
  const socialGap = numberOrZero(social?.data.winRateGap);
  const hasSocialSignal = social?.isSignificant === true && socialWorseBucket && socialGap >= 10;

  const luck = summary.xpnlLuckScore;
  const hasNegativeLuck = typeof luck === 'number' && luck < -0.2;

  if (!hasSocialSignal && !hasNegativeLuck) return null;

  const evidence: string[] = [];
  if (hasSocialSignal) {
    evidence.push(
      `Win rate drops ${Math.round(socialGap)}pp on high-social-attention trades`,
    );
  }
  if (hasNegativeLuck && luck != null) {
    evidence.push(`xPnL luck score: ${Math.round(luck * 100)}% (underperforming expected)`);
  }

  const diagnosisParts: string[] = [];
  if (hasSocialSignal) {
    diagnosisParts.push('Trades taken around high social attention have a lower win rate than your low-attention trades.');
  }
  if (hasNegativeLuck) {
    diagnosisParts.push('Your actual P&L is running meaningfully below what similar setups historically produced.');
  }
  const diagnosis = diagnosisParts.join(' ');

  const prescription = hasSocialSignal
    ? 'Treat high social attention as a caution flag, not a buy signal.'
    : 'Audit your sources — the signals you act on may not have edge for you.';

  return {
    id: 'information_quality',
    theme: 'information_quality',
    severity: 'warning',
    headline: 'Your information sources may not be helping',
    diagnosis,
    evidence,
    prescription,
    expectedImpact: 'Filtering out low-edge signals preserves capital for high-edge trades.',
    supportingInsightIds: supportingIds([social]),
    convergenceStrength: [hasSocialSignal, hasNegativeLuck].filter(Boolean).length,
    priority: priorityFor('information_quality', avgConfidence([social]) || 0.6, 500),
    tabLink: 'insights',
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findInsight(insights: Insight[], moduleName: string): Insight | undefined {
  return insights.find((i) => i.module === moduleName);
}

function pushIfPresent<T>(arr: T[], value: T | null | undefined): void {
  if (value != null) arr.push(value);
}

function priorityFor(
  theme: ThemeId,
  confidence: number,
  dollarImpact: number,
): number {
  const clampedConfidence = Math.max(0.1, Math.min(1, confidence));
  const magnitude = Math.log(1 + Math.abs(dollarImpact));
  return ACTIONABILITY[theme] * clampedConfidence * magnitude;
}

function avgConfidence(insights: (Insight | undefined | null)[]): number {
  const vals = insights
    .filter((i): i is Insight => i != null && typeof i.confidence === 'number')
    .map((i) => i.confidence);
  if (vals.length === 0) return 0.7;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function supportingIds(insights: (Insight | undefined | null)[]): string[] {
  return insights
    .filter((i): i is Insight => i != null)
    .map((i) => i.module);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function formatMoney(amount: number): string {
  const rounded = Math.round(Math.abs(amount));
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${rounded.toLocaleString()}`;
}

function formatRegime(regime: string): string {
  return regime
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
