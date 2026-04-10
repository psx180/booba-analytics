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

export interface MetricComputeSummary {
  computed: number;
  skipped: number;
  positionsSeen: number;
}

export interface InsightRunSummary {
  insights: Insight[];
  skipped: string[];
}

export class AnalyticsService {
  constructor(
    private readonly metrics: MetricComputer[],
    private readonly aggregators: Aggregator[],
    private readonly insightDetectors: InsightDetector[],
    private readonly db: PrismaClient,
  ) {}

  // ─── Type 1: Metrics ────────────────────────────────────────────────────

  async computeMetrics(walletAddress: string): Promise<MetricComputeSummary> {
    const positions = await this.db.position.findMany({
      where: { walletAddress, status: 'closed' },
    });

    let computed = 0;
    let skipped = 0;

    for (const position of positions) {
      const updates: Record<string, any> = {};
      for (const metric of this.metrics) {
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

    return { computed, skipped, positionsSeen: positions.length };
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
    const insights: Insight[] = [];
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
    return insights;
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

function confidenceBand(value: number): 'high' | 'medium' | 'low' {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}
