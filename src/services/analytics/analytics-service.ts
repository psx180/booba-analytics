/**
 * AnalyticsService — orchestrates the three analytics systems.
 *
 *   computeMetrics()  → runs all registered MetricComputers on positions
 *                       missing metrics, writes results back to each row.
 *   aggregate()       → runs a named Aggregator with filters, returns result.
 *   aggregateAll()    → runs every aggregator (for dashboard bootstrap).
 *   detectInsights()  → runs all registered InsightDetectors (that have
 *                       enough data), persists the results to
 *                       booba_observations, returns them.
 *
 * The service does not know what any individual module computes. It loops
 * over the registries and calls the standard interface methods. Adding a
 * new metric / aggregator / detector means creating a file, implementing
 * the interface, and adding it to the registry in index.ts. Nothing in this
 * file changes.
 */

import type { PrismaClient, Position } from '../../../generated/prisma/client';
import type {
  MetricComputer,
  Aggregator,
  InsightDetector,
  AggregationResult,
  Insight,
  Filters,
} from './types';
import { benjaminiHochberg } from './statistics';
import { TiltService, createDefaultTiltDetector, createHeuristicTiltDetector } from './tilt';
import { computeEloResult, type EloResult } from './metrics/elo';
import { computeXpnlResult, type XpnlResult } from './metrics/xpnl';
import { computeWartResult, type WartResult } from './metrics/wart';
import { computeEntropyResult, type EntropyResult } from './insights/entropy-insight';
import { computeRiskMetrics, type RiskMetrics } from './metrics/risk-metrics';
import { performanceAggregator } from './aggregations/performance';
import { equityCurveAggregator, getEquityCurveAsync } from './aggregations/equity-curve';
import { defaultEquityProvider } from './equity';

export interface MetricComputeSummary {
  computed: number;
  skipped: number;
  positionsSeen: number;
  tilt?: {
    totalEpisodes    : number;
    positionsAffected: number;
  };
}

export interface InsightRunSummary {
  insights: Insight[];
  skipped: string[];
}

export interface AdvancedSummary {
  /** The classic performance aggregation (winRate, expectancy, etc.) */
  performance: AggregationResult;
  eloResult: EloResult;
  entropyResult: EntropyResult;
  /** Total xPnL luck score plus the cumulative dual series for the chart overlay. */
  xpnl: XpnlResult;
  xpnlLuckScore: number;
  /** R² of cumulative P&L vs trade index from the equity curve aggregator. */
  equityCurveConsistency: number;
  /** Composite trader score (WART) decomposed into 5 axes. */
  wartResult: WartResult;
  /** Risk-adjusted metrics: Sharpe, Sortino, payoff ratio, drawdown analysis, fees. */
  riskMetrics: RiskMetrics;
}

export class AnalyticsService {
  private readonly tiltService: TiltService;

  constructor(
    private readonly metrics: MetricComputer[],
    private readonly aggregators: Aggregator[],
    private readonly insightDetectors: InsightDetector[],
    private readonly db: PrismaClient,
  ) {
    this.tiltService = new TiltService(createDefaultTiltDetector(), db);
  }

  // ─── Type 1: Metrics ────────────────────────────────────────────────────

  async computeMetrics(
    walletAddress: string,
    journalId?: string,
    tier?: 'fast' | 'slow',
  ): Promise<MetricComputeSummary> {
    // Journal scoping: only compute metrics for positions in the requested
    // journal. When omitted, falls back to wallet-wide for back-compat with
    // scripts. The route layer always supplies a journalId so the dashboard
    // never produces metrics that span journals.
    const where: any = { walletAddress, status: 'closed' };
    if (journalId) where.journalId = journalId;

    const positions = await this.db.position.findMany({ where });

    console.log(
      `[analytics] computeMetrics: ${positions.length} closed positions for ${walletAddress}` +
      (journalId ? ` (journal=${journalId})` : '') +
      (tier ? ` (tier=${tier})` : ''),
    );

    // When a tier is specified, only run metrics matching that tier.
    // Untagged metrics default to 'fast'.
    const metricsToRun = tier
      ? this.metrics.filter((m) => (m.tier ?? 'fast') === tier)
      : this.metrics;

    // Run any batch metric computers up front. The result is a per-metric map
    // from positionId → metric updates that the per-position loop merges into
    // each row's update payload. Used by metrics that need full-history context
    // (xPnL KNN leave-one-out, sequential Elo) or that need to perform async
    // I/O (exit-quality fetches candles per asset). computeAll may return
    // either a Map or a Promise<Map>, so we await both cases.
    const batchResults = new Map<string, Map<string, Record<string, number | string | null>>>();
    for (const metric of metricsToRun) {
      if (typeof metric.computeAll !== 'function') continue;
      try {
        const result = await metric.computeAll(positions);
        batchResults.set(metric.name, result);
        console.log(`[analytics] batch ${metric.name}: ${result.size} positions computed`);
      } catch (err) {
        console.error(`[analytics] batch metric ${metric.name} failed:`, err);
      }
    }

    let computed = 0;
    let skipped = 0;

    for (const position of positions) {
      const updates: Record<string, any> = {};

      for (const metric of metricsToRun) {
        const batchMap = batchResults.get(metric.name);
        if (batchMap) {
          // Batch metric — pull this position's precomputed values out of the map.
          const result = batchMap.get(position.id);
          if (result) {
            for (const [key, value] of Object.entries(result)) {
              if (value != null) updates[key] = value;
            }
          }
          continue;
        }
        const result = metric.compute(position);
        for (const [key, value] of Object.entries(result)) {
          if (value != null) updates[key] = value;
        }
      }

      if (Object.keys(updates).length === 0) {
        skipped++;
        continue;
      }

      await this.db.position.update({
        where: { id: position.id },
        data: updates,
      });
      computed++;
    }

    console.log(`[analytics] computeMetrics done — computed=${computed} skipped=${skipped}`);

    // ─── Tilt detection pass ─────────────────────────────────────────
    // Runs after standard metrics so tilt scores reflect the latest
    // computed state. Skip when tier='slow' — tilt is fast-tier work
    // already covered by the fast-tier run.
    let tiltSummary: { totalEpisodes: number; positionsAffected: number } | undefined;
    if (tier === 'slow') {
      return { computed, skipped, positionsSeen: positions.length };
    }
    try {
      const tiltResult = await this.tiltService.analyzeAndPersist(walletAddress, journalId);
      tiltSummary = tiltResult.summary;

      // Parallel comparison against the heuristic scorer.
      try {
        const heuristic = createHeuristicTiltDetector();
        const heuristicWhere: any = { walletAddress };
        if (journalId) heuristicWhere.journalId = journalId;
        const allPositions = await this.db.position.findMany({
          where  : heuristicWhere,
          orderBy: { firstEntryTime: 'asc' },
        });
        const comparison = heuristic.detect(allPositions as unknown as Position[]);
        const aboveThreshold = comparison.scores.filter((s) => s.score > 0.5).length;
        console.log(
          `[tilt] heuristic scorer comparison: ${aboveThreshold}/${comparison.scores.length} ` +
          `positions above 0.5, ${comparison.episodes.length} episodes detected`,
        );
      } catch (err) {
        console.error('[tilt] heuristic comparison failed:', err);
      }
    } catch (err) {
      console.error('[tilt] analyzeAndPersist failed:', err);
    }

    return { computed, skipped, positionsSeen: positions.length, tilt: tiltSummary };
  }

  // ─── Direct tilt access ────────────────────────────────────────────────
  /** Expose the internal tilt service for API routes / scripts that want it. */
  getTiltService(): TiltService {
    return this.tiltService;
  }

  // ─── Type 2: Aggregations ───────────────────────────────────────────────

  async aggregate(
    name: string,
    walletAddress: string,
    filters?: Filters,
    options?: Record<string, any>,
  ): Promise<AggregationResult> {
    const positions = await this.loadFilteredPositions(walletAddress, filters);
    const aggregator = this.aggregators.find((a) => a.name === name);
    if (!aggregator) {
      throw new Error(`Unknown aggregator: ${name}`);
    }
    return (aggregator.aggregate as any)(positions, options ?? filters);
  }

  /**
   * Async equity-curve path that routes through the pluggable
   * EquitySourceProvider. Callers opt in when EQUITY_PROVIDER_MODE is set
   * to something other than 'legacy'; the sync aggregator path remains the
   * default so existing output is byte-identical until the feature is
   * explicitly enabled.
   */
  async aggregateEquityCurveAsync(
    walletAddress: string,
    filters?: Filters,
  ): Promise<AggregationResult> {
    const positions = await this.loadFilteredPositions(walletAddress, filters);
    // A filter that narrows positions (regime/asset/strategy/tradeType/date)
    // can't be reflected in an unfiltered snapshot history, so tell the
    // equity-curve builder to take the position-based path. Journal is an
    // always-present scope, not a user-selected narrowing, so it doesn't
    // trigger the fallback on its own.
    const hasNarrowingFilter = Boolean(
      filters?.regime ||
      filters?.asset ||
      filters?.strategy ||
      filters?.tradeType ||
      filters?.source ||
      filters?.builderCode ||
      filters?.dateFrom ||
      filters?.dateTo,
    );
    return getEquityCurveAsync(walletAddress, positions, {
      forcePositionBased: hasNarrowingFilter,
    });
  }

  async aggregateAll(
    walletAddress: string,
    filters?: Filters,
  ): Promise<Record<string, AggregationResult>> {
    const positions = await this.loadFilteredPositions(walletAddress, filters);
    const results: Record<string, AggregationResult> = {};
    for (const aggregator of this.aggregators) {
      // Skip aggregators that require extra options (breakdown, what-if);
      // they must be called explicitly via aggregate().
      if (aggregator.name === 'breakdown' || aggregator.name === 'what-if') continue;
      results[aggregator.name] = aggregator.aggregate(positions, filters);
    }
    return results;
  }

  /**
   * Composed dashboard summary that bundles performance, Elo, entropy, xPnL,
   * and equity-curve consistency in a single payload. Used by the dashboard
   * stats bar so the client only fires one request to populate every card.
   */
  async getAdvancedSummary(
    walletAddress: string,
    filters?: Filters,
  ): Promise<AdvancedSummary> {
    const positions = await this.loadFilteredPositions(walletAddress, filters);

    const performance = performanceAggregator.aggregate(positions, filters);
    const equityCurve = equityCurveAggregator.aggregate(positions, filters);
    const equityCurveConsistency =
      typeof equityCurve.data?.consistency === 'number'
        ? (equityCurve.data.consistency as number)
        : 0;

    // Override totalPnl with fill-level sum so it stays constant regardless of
    // how positions are merged or split. Position.aggregatePnl can diverge from
    // the fill total due to volume-weighted averaging across merged groups.
    //
    // When a journal is in scope we must restrict the fill sum to fills that
    // belong to positions in this journal — otherwise the dashboard would
    // show wallet-wide P&L even when the user has narrowed to one journal.
    // The walk is Trade → OrderGroup → Position.journalId.
    const fillWhere: Record<string, any> = { walletAddress };
    if (filters?.asset) fillWhere.asset = filters.asset;
    if (filters?.regime) fillWhere.regimeAtEntry = filters.regime;
    if (filters?.dateFrom || filters?.dateTo) {
      fillWhere.entryTime = {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo   ? { lte: filters.dateTo }   : {}),
      };
    }
    if (filters?.journalId) {
      fillWhere.orderGroup = {
        is: { position: { is: { journalId: filters.journalId } } },
      };
    }
    const fillSum = await this.db.trade.aggregate({
      _sum: { pnlRealized: true },
      where: fillWhere,
    });
    performance.data.totalPnl = Math.round((fillSum._sum.pnlRealized ?? 0) * 100) / 100;

    const eloResult = computeEloResult(positions);
    const entropyResult = computeEntropyResult(positions);
    const xpnl = computeXpnlResult(positions);
    // Risk metrics now express returns as a % of equity-at-entry. The
    // starting capital anchor comes from the active equity provider so it
    // reflects the same deposit/history model the equity chart uses — not a
    // hard-coded $10k — keeping Sharpe comparable across accounts.
    const startingCapital = await defaultEquityProvider.getStartingCapital(walletAddress);
    const riskMetrics = computeRiskMetrics(positions, startingCapital);

    // WART consumes the existing computed dependencies plus the drawdown
    // fields from the equity curve aggregator. Pass them through so the
    // axes match exactly what the dashboard sees elsewhere.
    const wartResult = computeWartResult(positions, {
      xpnlResult: xpnl,
      entropyResult,
      drawdown: {
        maxDrawdown:         (equityCurve.data?.maxDrawdown ?? 0) as number,
        maxDrawdownPct:      (equityCurve.data?.maxDrawdownPct ?? 0) as number,
        maxDrawdownDuration: (equityCurve.data?.maxDrawdownDuration ?? 0) as number,
        currentDrawdown:     (equityCurve.data?.currentDrawdown ?? 0) as number,
      },
      equityCurveTradeCount: (equityCurve.data?.tradeCount ?? positions.length) as number,
    });

    return {
      performance,
      eloResult,
      entropyResult,
      xpnl,
      xpnlLuckScore: xpnl.luckScore,
      equityCurveConsistency,
      wartResult,
      riskMetrics,
    };
  }

  // ─── Type 3: Insights ───────────────────────────────────────────────────

  async detectInsights(
    walletAddress: string,
    journalId?: string,
  ): Promise<InsightRunSummary> {
    // Load only the journal's positions so insights are computed entirely
    // from the journal's own data — independent equity curve, independent
    // disposition effect, independent everything.
    const positions = await this.loadFilteredPositions(walletAddress, { journalId });
    let insights: Insight[] = [];
    const skipped: string[] = [];

    // Provide performance + equity-curve results to detectors that want them.
    const aggregations: Record<string, AggregationResult> = {};
    for (const aggregator of this.aggregators) {
      if (aggregator.name === 'breakdown' || aggregator.name === 'what-if') continue;
      aggregations[aggregator.name] = aggregator.aggregate(positions);
    }

    for (const detector of this.insightDetectors) {
      if (positions.length < detector.minimumPositions) {
        skipped.push(detector.name);
        continue;
      }
      try {
        const results = detector.detect(positions, aggregations);
        insights.push(...results);
      } catch (err) {
        console.error(`[analytics] detector ${detector.name} failed:`, err);
        skipped.push(detector.name);
      }
    }

    // Apply Benjamini-Hochberg FDR correction across all detectors
    const totalTests = insights.reduce((s, i) => s + i.statistics.length, 0);
    insights = benjaminiHochberg(insights);
    const significantTests = insights.reduce(
      (s, i) => s + i.statistics.filter((t) => t.isSignificant).length, 0,
    );
    console.log(
      `[analytics] BH correction applied: ${significantTests} of ${totalTests} tests remain significant at FDR=0.10`,
    );

    // Assign tier classification after BH correction.
    // 'descriptive' modules produce facts about the data (not hypothesis tests)
    // and are always shown in the actionable section regardless of significance.
    const DESCRIPTIVE_MODULES = new Set([
      'exit-optimizer',
      'time-of-day-edge',
      'hold-time-optimizer',
      'outlier-dependency',
    ]);
    for (const insight of insights) {
      const primaryTest = insight.statistics[0];
      if (primaryTest?.testName === 'descriptive' || DESCRIPTIVE_MODULES.has(insight.module)) {
        insight.tier = 'descriptive';
      } else if (insight.isSignificant) {
        insight.tier = 'significant';
      } else if (primaryTest && primaryTest.pValue < 0.10) {
        insight.tier = 'preliminary';
      } else {
        insight.tier = 'not_detected';
      }
    }

    // Sort by impactScore descending — highest-impact insights first
    insights.sort((a, b) => b.impactScore - a.impactScore);

    const significantCount = insights.filter((i) => i.isSignificant).length;
    console.log(
      `[analytics] Found ${insights.length} insights. ${significantCount} are statistically significant.`,
    );

    // Persist to booba_observations. Deactivate prior observations from the
    // same module *for this journal* so stored insights reflect the latest
    // run without trampling sibling journals on the same wallet.
    const modulesProduced = new Set(insights.map((i) => i.module));
    if (modulesProduced.size > 0) {
      await this.db.boobaObservation.updateMany({
        where: {
          walletAddress,
          journalId: journalId ?? null,
          sourceModule: { in: Array.from(modulesProduced) },
          isActive: true,
        },
        data: { isActive: false },
      });
    }

    for (const insight of insights) {
      await this.db.boobaObservation.create({
        data: {
          walletAddress,
          journalId: journalId ?? null,
          observationText: JSON.stringify(insight),
          confidence: confidenceBand(insight.confidence),
          sourceModule: insight.module,
          isActive: true,
          impactScore: insight.impactScore,
          category: insight.category,
          isSignificant: insight.isSignificant,
        },
      });
    }

    return { insights, skipped };
  }

  /**
   * Return previously-stored active insights without re-running detectors.
   * Pass `journalId` to read only this journal's stored insights — when
   * omitted (legacy callers), reads everything for the wallet.
   */
  async getStoredInsights(
    walletAddress: string,
    journalId?: string,
  ): Promise<{ insights: Insight[]; lastComputedAt: Date | null }> {
    const where: any = {
      walletAddress,
      isActive: true,
      // Belt-and-suspenders: ignore observations older than 30 days to
      // prevent stale-but-active rows from accumulating indefinitely.
      createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
    };
    if (journalId) where.journalId = journalId;
    const rows = await this.db.boobaObservation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const insights: Insight[] = [];
    let lastComputedAt: Date | null = null;
    for (const row of rows) {
      if (!lastComputedAt) lastComputedAt = row.createdAt;
      try {
        insights.push(JSON.parse(row.observationText));
      } catch {
        // Legacy rows may not be JSON — skip.
      }
    }
    // Deduplicate by module — keep the highest-impact insight per module.
    // Multiple rows for the same module can accumulate when a detector runs
    // on per-subset data (per cluster, per regime) and each subset emits its
    // own observation. Group by module and keep the best representative.
    const moduleMap = new Map<string, Insight>();
    for (const insight of insights) {
      const existing = moduleMap.get(insight.module);
      if (!existing || (insight.impactScore ?? 0) > (existing.impactScore ?? 0)) {
        moduleMap.set(insight.module, insight);
      }
    }
    const deduped = Array.from(moduleMap.values());

    // Sort significant insights first, then by impactScore descending
    deduped.sort((a, b) => {
      if (a.isSignificant !== b.isSignificant) return a.isSignificant ? -1 : 1;
      return (b.impactScore ?? 0) - (a.impactScore ?? 0);
    });
    return { insights: deduped, lastComputedAt };
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private async loadFilteredPositions(
    walletAddress: string,
    filters?: Filters,
  ): Promise<Position[]> {
    const where: any = { walletAddress };

    // Journal scope is the *primary* filter for the multi-journal system —
    // every analytic (equity curve, Elo, WART, insights) is computed only on
    // positions in this journal so each journal gets a truly independent
    // view. Callers should always supply this; the API routes do, but the
    // service stays robust if a script calls it without one.
    if (filters?.journalId) where.journalId = filters.journalId;

    if (filters?.regime) where.regimeAtEntry = filters.regime;
    if (filters?.asset) where.asset = filters.asset;
    if (filters?.strategy) where.strategyId = filters.strategy;
    if (filters?.tradeType) {
      // Match positions where the effective type (manualTradeType ?? tradeType) equals the filter
      where.OR = [
        { manualTradeType: filters.tradeType },
        { manualTradeType: null, tradeType: filters.tradeType },
      ];
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.firstEntryTime = {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {}),
      };
    }

    if (filters?.builderCode) {
      const builderClause = {
        orderGroups: { some: { trades: { some: { builderCode: filters.builderCode } } } },
      };
      if (filters.builderCodeExclude) {
        where.NOT = builderClause;
      } else {
        Object.assign(where, builderClause);
      }
    }

    return this.db.position.findMany({ where });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function confidenceBand(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}
