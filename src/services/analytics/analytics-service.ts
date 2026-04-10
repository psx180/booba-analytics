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
  Candle,
} from './types';
import { benjaminiHochberg } from './statistics';
import { TiltService, createDefaultTiltDetector, createHeuristicTiltDetector } from './tilt';

export interface CandleSource {
  fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]>;
}

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

export class AnalyticsService {
  private readonly tiltService: TiltService;

  constructor(
    private readonly metrics: MetricComputer[],
    private readonly aggregators: Aggregator[],
    private readonly insightDetectors: InsightDetector[],
    private readonly db: PrismaClient,
    private readonly candleSource?: CandleSource,
  ) {
    this.tiltService = new TiltService(createDefaultTiltDetector(), db);
  }

  // ─── Type 1: Metrics ────────────────────────────────────────────────────

  async computeMetrics(walletAddress: string): Promise<MetricComputeSummary> {
    const positions = await this.db.position.findMany({
      where: { walletAddress, status: 'closed' },
    });

    console.log(`[analytics] computeMetrics: ${positions.length} closed positions for ${walletAddress}`);

    // Positions that need MFE/MAE derived from candles (mfePnl not yet stored).
    // Only guard on firstEntryTime — averageEntryPrice null is handled gracefully
    // inside deriveFromCandles, and excluding on it silently empties needsCandles
    // for positions created via split/merge where averageEntryPrice wasn't written.
    const needsCandles = positions.filter(
      (p) => p.mfePnl == null && p.firstEntryTime != null,
    );

    console.log(
      `[analytics] needsCandles=${needsCandles.length}/${positions.length} ` +
      `(excluded ${positions.length - needsCandles.length}: ` +
      `${positions.filter((p) => p.mfePnl != null).length} already have mfePnl, ` +
      `${positions.filter((p) => p.mfePnl == null && p.firstEntryTime == null).length} missing firstEntryTime)`,
    );

    if (needsCandles.length > 0 && !this.candleSource) {
      console.warn(
        `[analytics] ${needsCandles.length} positions need MFE/MAE but no candle source configured — exitEfficiency will stay null`,
      );
    }

    const candlesByPosition = await this.fetchCandlesForPositions(needsCandles);

    console.log(`[analytics] candlesByPosition map has ${candlesByPosition.size} entries`);

    let computed = 0;
    let skipped = 0;

    for (const position of positions) {
      const positionCandles = candlesByPosition.get(position.id);
      const updates: Record<string, any> = {};

      for (const metric of this.metrics) {
        console.log(
          `[analytics] → ${metric.name} on ${position.id} (${position.asset}): ` +
          `priceData=${positionCandles !== undefined ? `${positionCandles.length} candles` : 'undefined'}`,
        );
        const result = metric.compute(position, positionCandles);
        for (const [key, value] of Object.entries(result)) {
          if (value != null) updates[key] = value;
        }
      }

      if (Object.keys(updates).length === 0) {
        console.log(
          `[analytics] skip ${position.id} (${position.asset} ${position.direction}) — ` +
          `mfePrice=${position.mfePrice} entry=${position.averageEntryPrice} exit=${position.averageExitPrice} ` +
          `candles=${positionCandles?.length ?? 'none'}`,
        );
        skipped++;
        continue;
      }

      console.log(
        `[analytics] write ${position.id} (${position.asset}): ` +
        Object.entries(updates)
          .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`)
          .join(' '),
      );

      await this.db.position.update({
        where: { id: position.id },
        data: updates,
      });
      computed++;
    }

    console.log(`[analytics] computeMetrics done — computed=${computed} skipped=${skipped}`);

    // ─── Tilt detection pass ─────────────────────────────────────────
    // Runs after standard metrics so tilt scores reflect the latest
    // computed state. The default detector persists its output; the
    // heuristic scorer is also run (dev comparison only — no persistence).
    let tiltSummary: { totalEpisodes: number; positionsAffected: number } | undefined;
    try {
      const tiltResult = await this.tiltService.analyzeAndPersist(walletAddress);
      tiltSummary = tiltResult.summary;

      // Parallel comparison against the heuristic scorer.
      try {
        const heuristic = createHeuristicTiltDetector();
        const allPositions = await this.db.position.findMany({
          where  : { walletAddress },
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

  // ─── Type 3: Insights ───────────────────────────────────────────────────

  async detectInsights(walletAddress: string): Promise<InsightRunSummary> {
    const positions = await this.loadFilteredPositions(walletAddress);
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

    // Sort by impactScore descending — highest-impact insights first
    insights.sort((a, b) => b.impactScore - a.impactScore);

    const significantCount = insights.filter((i) => i.isSignificant).length;
    console.log(
      `[analytics] Found ${insights.length} insights. ${significantCount} are statistically significant.`,
    );

    // Persist to booba_observations. Deactivate prior observations from the
    // same module for this wallet so stored insights reflect the latest run.
    const modulesProduced = new Set(insights.map((i) => i.module));
    if (modulesProduced.size > 0) {
      await this.db.boobaObservation.updateMany({
        where: {
          walletAddress,
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

  /** Return previously-stored active insights without re-running detectors. */
  async getStoredInsights(walletAddress: string): Promise<Insight[]> {
    const rows = await this.db.boobaObservation.findMany({
      where: { walletAddress, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    const insights: Insight[] = [];
    for (const row of rows) {
      try {
        insights.push(JSON.parse(row.observationText));
      } catch {
        // Legacy rows may not be JSON — skip.
      }
    }
    // Sort significant insights first, then by impactScore descending
    insights.sort((a, b) => {
      if (a.isSignificant !== b.isSignificant) return a.isSignificant ? -1 : 1;
      return (b.impactScore ?? 0) - (a.impactScore ?? 0);
    });
    return insights;
  }

  // ─── Candle fetching ────────────────────────────────────────────────────

  /**
   * Fetches candles for positions that need MFE/MAE data.
   * Groups by asset to minimize API calls — one request per asset covering
   * the full date range of all positions for that asset.
   */
  private async fetchCandlesForPositions(
    positions: Position[],
  ): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>();
    if (!this.candleSource || positions.length === 0) return result;

    // Group by asset
    const byAsset = new Map<string, Position[]>();
    for (const p of positions) {
      if (!byAsset.has(p.asset)) byAsset.set(p.asset, []);
      byAsset.get(p.asset)!.push(p);
    }

    for (const [asset, assetPositions] of byAsset) {
      const times = assetPositions.flatMap((p) => [
        p.firstEntryTime?.getTime(),
        p.lastExitTime?.getTime(),
      ]).filter((t): t is number => t != null && t > 0);

      if (times.length === 0) continue;

      const startTime = new Date(Math.min(...times) - 5 * 60 * 1000); // 5m buffer before
      const endTime   = new Date(Math.max(...times) + 5 * 60 * 1000); // 5m buffer after

      const symbol = toBinanceSymbol(asset);

      try {
        console.log(
          `[analytics] fetching 5m candles for ${asset} → Binance ${symbol} ` +
          `[${startTime.toISOString()} → ${endTime.toISOString()}]`,
        );
        const candles = await this.candleSource.fetchCandles(symbol, '5m', startTime, endTime);
        console.log(`[analytics] received ${candles.length} candles for ${asset}`);

        if (candles.length === 0) {
          console.warn(
            `[analytics] 0 candles for ${symbol} — symbol mapping may be wrong or ` +
            `data not available for this date range`,
          );
        }

        // Assign each position its candle slice
        for (const p of assetPositions) {
          if (!p.firstEntryTime) continue;
          const posStart = p.firstEntryTime.getTime();
          const posEnd   = (p.lastExitTime ?? new Date()).getTime();
          const slice = candles.filter(
            (c) => c.timestamp.getTime() >= posStart && c.timestamp.getTime() <= posEnd,
          );
          console.log(
            `[analytics]   position ${p.id} (${p.direction}): ` +
            `${slice.length} candles in [${p.firstEntryTime.toISOString()} → ` +
            `${p.lastExitTime?.toISOString() ?? 'now'}]`,
          );
          result.set(p.id, slice);
        }
      } catch (err) {
        console.error(`[analytics] candle fetch failed for ${symbol}:`, err);
      }
    }

    return result;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private async loadFilteredPositions(
    walletAddress: string,
    filters?: Filters,
  ): Promise<Position[]> {
    const where: any = { walletAddress };

    if (filters?.regime) where.regimeAtEntry = filters.regime;
    if (filters?.asset) where.asset = filters.asset;
    if (filters?.strategy) where.strategyId = filters.strategy;
    if (filters?.tradeType) where.tradeType = filters.tradeType;

    if (filters?.dateFrom || filters?.dateTo) {
      where.firstEntryTime = {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {}),
      };
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

/**
 * Convert a Pacifica asset symbol to Binance spot symbol.
 * "BTC-PERP" → "BTCUSDT", "SOL-PERP" → "SOLUSDT"
 */
function toBinanceSymbol(pacificaAsset: string): string {
  const base = pacificaAsset.split('-')[0].toUpperCase();
  return `${base}USDT`;
}
