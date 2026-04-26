/**
 * Trading-report orchestrator.
 *
 * Loads every analytic in parallel ONCE and hands the resulting bundle to
 * each pure-function section generator. Section files are oblivious to
 * each other and to the database — adding a section means writing one
 * file under sections/ and adding one call here.
 *
 * Returns a fully-populated TradingReport. Sections that don't have data
 * yet (slow tier hasn't run, sample too small, Monte Carlo unavailable)
 * are returned as null instead of throwing.
 */

import { prisma } from '../../lib/prisma';
import { resolveJournalFilterId } from '../../lib/journals';
import { createAnalyticsService } from '../analytics';
import type { Filters, Insight } from '../analytics/types';
import { computeRiskMetrics } from '../analytics/metrics/risk-metrics';
import { computeEloResult } from '../analytics/metrics/elo';
import { computeWartResult } from '../analytics/metrics/wart';
import { computeXpnlResult } from '../analytics/metrics/xpnl';
import { computeEntropyResult } from '../analytics/insights/entropy-insight';
import { detectConvergentThemes } from '../analytics/convergence';
import { runMonteCarloSimulation } from '../analytics/monte-carlo';
import { computeWalkForward } from '../analytics/walk-forward';
import { defaultEquityProvider } from '../analytics/equity';
import { computeDrawdownSummary } from '../analytics/equity/drawdown';
import { equityCurveAggregator } from '../analytics/aggregations/equity-curve';
import { breakdownAggregator } from '../analytics/aggregations/breakdown';
import { performanceAggregator } from '../analytics/aggregations/performance';
import { createDefaultTiltDetector } from '../analytics/tilt';
import { deriveMonteCarloInput } from './monte-carlo-input';
import { generateExecutiveSummary } from './sections/executive-summary';
import { generatePerformance } from './sections/performance';
import { generateBehavioral } from './sections/behavioral';
import { generateRisk } from './sections/risk';
import { generateExecution } from './sections/execution';
import { generateRegime } from './sections/regime';
import { generateMethodology } from './sections/methodology';
import type { ReportData } from './data';
import type { TradingReport } from './types';

const REGIME_LABEL: Record<string, string> = {
  trending_low_vol: 'Trending (low vol)',
  trending_high_vol: 'Trending (high vol)',
  ranging_low_vol: 'Ranging (low vol)',
  ranging_high_vol: 'Ranging (high vol)',
  transitional: 'Transitional',
};

export async function generateReport(
  walletAddress: string,
  journalId?: string,
  filters?: Filters,
): Promise<TradingReport> {
  // Resolve journal id via the same helper API routes use, so omitting it
  // falls back to the wallet's default journal instead of going wallet-wide.
  const resolved = await resolveJournalFilterId(walletAddress, journalId ?? null);
  const effectiveFilters: Filters = { ...(filters ?? {}) };
  if (resolved.valid && resolved.id) effectiveFilters.journalId = resolved.id;

  const service = createAnalyticsService();
  const positions = await service.loadPositions(walletAddress, effectiveFilters);
  const closedPositions = positions.filter(
    (p) => p.status === 'closed' && p.aggregatePnl != null,
  );

  // Run everything else in parallel. Each block is independent and either
  // returns its result, or null/[] when it can't run (we never throw).
  const [
    startingCapital,
    equityCurve,
    storedInsightsRes,
    convergence,
    walkForward,
    regimeBreakdownRes,
    tradeTypeBreakdownRes,
    currentRegimeRow,
  ] = await Promise.all([
    defaultEquityProvider.getStartingCapital(walletAddress).catch(() => 10000),
    defaultEquityProvider.getEquityCurve(walletAddress, closedPositions).catch(() => []),
    service.getStoredInsights(walletAddress, effectiveFilters.journalId).catch(() => ({ insights: [] as Insight[], lastComputedAt: null })),
    detectConvergentThemes(walletAddress, effectiveFilters.journalId).catch((): any => ({
      themes: [], biggestLeak: null, biggestStrength: null, weeklyFocus: null,
      tradeCount: 0, insufficientData: true,
    })),
    safeWalkForward(walletAddress, effectiveFilters.journalId),
    Promise.resolve(breakdownAggregator.aggregate(positions, { groupBy: 'regime' })),
    Promise.resolve(breakdownAggregator.aggregate(positions, { groupBy: 'tradeType' })),
    prisma.regimeSnapshot.findFirst({ orderBy: { timestamp: 'desc' } }).catch(() => null),
  ]);

  const performance = performanceAggregator.aggregate(positions, effectiveFilters);
  const equityCurveAgg = equityCurveAggregator.aggregate(positions, effectiveFilters);
  const drawdownSummary = computeDrawdownSummary(equityCurve);

  // Risk metrics consume positions + starting capital (matches the
  // dashboard summary's wiring exactly).
  const riskMetrics = computeRiskMetrics(positions, startingCapital);

  // Elo + xPnL + entropy feed WART; same dependency graph the analytics
  // service uses for the dashboard.
  const eloResult = computeEloResult(positions);
  const xpnl = computeXpnlResult(positions);
  const entropyResult = computeEntropyResult(positions);
  const wartResult = computeWartResult(positions, {
    xpnlResult: xpnl,
    entropyResult,
    drawdown: {
      maxDrawdown: (equityCurveAgg.data?.maxDrawdown ?? 0) as number,
      maxDrawdownPct: (equityCurveAgg.data?.maxDrawdownPct ?? 0) as number,
      maxDrawdownDuration: (equityCurveAgg.data?.maxDrawdownDuration ?? 0) as number,
      currentDrawdown: (equityCurveAgg.data?.currentDrawdown ?? 0) as number,
    },
    equityCurveTradeCount: (equityCurveAgg.data?.tradeCount ?? positions.length) as number,
  });

  // Tilt episodes — re-run the default detector on the loaded positions so
  // we get fresh trigger/severity/duration information without touching the
  // persistence path the dashboard uses.
  const tiltDetector = createDefaultTiltDetector();
  const tiltDetection = (() => {
    try {
      return tiltDetector.detect(positions);
    } catch {
      return { scores: [], episodes: [] };
    }
  })();

  // Monte Carlo: derive input from positions + reconstructed equity. Returns
  // null below the 20-trade threshold (mirrors the existing route).
  const monteCarloDerived = deriveMonteCarloInput(closedPositions, equityCurve);
  const monteCarlo = monteCarloDerived
    ? safeRun(() => runMonteCarloSimulation(monteCarloDerived.input))
    : null;

  const generatedAt = new Date();

  const data: ReportData = {
    walletAddress,
    filters: effectiveFilters,
    positions,
    closedPositions,
    generatedAt,
    startingCapital,
    equityCurve,
    drawdownSummary,
    riskMetrics,
    eloResult,
    wartResult,
    convergence,
    monteCarlo,
    walkForward,
    storedInsights: storedInsightsRes.insights,
    insightsLastComputedAt: storedInsightsRes.lastComputedAt,
    currentRegime: currentRegimeRow?.regimeClassification ?? null,
    tiltEpisodes: tiltDetection.episodes,
    regimeBreakdown: regimeBreakdownRes.breakdowns?.regime ?? {},
    tradeTypeBreakdown: tradeTypeBreakdownRes.breakdowns?.tradeType ?? {},
    performance,
  };

  return {
    generatedAt: generatedAt.toISOString(),
    walletAddress,
    period: derivePeriod(positions, generatedAt),
    tradeCount: closedPositions.length,
    filtersDescription: describeFilters(effectiveFilters),
    sections: {
      executiveSummary: generateExecutiveSummary(data),
      performance: generatePerformance(data),
      behavioral: generateBehavioral(data),
      risk: generateRisk(data),
      execution: generateExecution(data),
      regime: generateRegime(data),
      methodology: generateMethodology(data),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function derivePeriod(
  positions: { firstEntryTime: Date | null; lastExitTime: Date | null }[],
  fallback: Date,
): { from: string; to: string } {
  let from: number | null = null;
  let to: number | null = null;
  for (const p of positions) {
    const start = p.firstEntryTime?.getTime();
    const end = p.lastExitTime?.getTime() ?? p.firstEntryTime?.getTime();
    if (start != null && (from == null || start < from)) from = start;
    if (end != null && (to == null || end > to)) to = end;
  }
  return {
    from: from != null ? new Date(from).toISOString() : fallback.toISOString(),
    to: to != null ? new Date(to).toISOString() : fallback.toISOString(),
  };
}

function describeFilters(f: Filters | undefined): string {
  if (!f) return '';
  const parts: string[] = [];
  if (f.regime) parts.push(`Regime: ${REGIME_LABEL[f.regime] ?? f.regime}`);
  if (f.asset) parts.push(`Asset: ${f.asset}`);
  if (f.tradeType) parts.push(`Trade type: ${f.tradeType}`);
  if (f.strategy) parts.push(`Strategy: ${f.strategy}`);
  if (f.source) parts.push(`Source: ${f.source}`);
  if (f.manualOnly) parts.push('Manual only');
  else if (f.builderCode) {
    parts.push(`Builder: ${f.builderCodeExclude ? 'excl. ' : ''}${f.builderCode}`);
  }
  if (f.excludeBuilderCodes && f.excludeBuilderCodes.length > 0) {
    parts.push(`Hide noise: ${f.excludeBuilderCodes.join(', ')}`);
  }
  if (f.dateFrom) parts.push(`From ${f.dateFrom.toISOString().slice(0, 10)}`);
  if (f.dateTo) parts.push(`To ${f.dateTo.toISOString().slice(0, 10)}`);
  return parts.join(' · ');
}

async function safeWalkForward(
  walletAddress: string,
  journalId: string | undefined,
) {
  try {
    return await computeWalkForward(prisma, walletAddress, journalId);
  } catch {
    return null;
  }
}

function safeRun<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
