/**
 * Core analytics types.
 *
 * Three kinds of computation, each a separate system:
 *
 *   1. Metrics       — per-position facts, computed once, stored on the
 *                      position record. Pure functions of position + price data.
 *   2. Aggregations  — cross-position stats, computed on demand, never stored.
 *                      Respect user filters.
 *   3. Insights      — pattern detection producing natural language, computed
 *                      periodically, stored in booba_observations.
 */

import type { Position } from '../../../generated/prisma/client';

// ─── Shared ────────────────────────────────────────────────────────────────

export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Filters {
  regime?: string;
  asset?: string;
  strategy?: string;
  source?: string;
  tradeType?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export type { Position };

// ─── Type 1: Metrics ───────────────────────────────────────────────────────

export interface MetricComputer {
  /** Unique name used for logging and registration. */
  name: string;
  /** Position fields this computer reads (for validation / documentation). */
  requiredFields: string[];
  /**
   * Compute metric key-value pairs from a single position.
   * Pure function — same input always produces same output.
   * Keys in the returned object must match Position schema field names
   * so the service can persist them directly.
   */
  compute(position: Position, priceData?: Candle[]): Record<string, number | string | null>;
}

// ─── Type 2: Aggregations ──────────────────────────────────────────────────

export interface DataPoint {
  date: string;
  value: number;
  [key: string]: any;
}

export interface AggregationResult {
  name: string;
  data: Record<string, any>;
  series?: DataPoint[];
  breakdowns?: Record<string, Record<string, any>>;
}

export interface Aggregator {
  name: string;
  aggregate(positions: Position[], filters?: Filters): AggregationResult;
}

// ─── Type 3: Insights ──────────────────────────────────────────────────────

export type InsightSeverity = 'info' | 'warning' | 'critical';

export type InsightCategory = 'exit' | 'entry' | 'behavior' | 'strategy' | 'risk' | 'timing' | 'pacifica';

export interface StatisticalTest {
  testName: string;           // 'welch_t_test' | 'chi_squared' | 'correlation'
  pValue: number;
  effectSize: number;         // Cohen's d for means, phi for proportions, |r| for correlation
  sampleSizeA: number;
  sampleSizeB: number;
  isSignificant: boolean;     // p < 0.05 (or Bonferroni-adjusted threshold)
  correctionApplied?: string; // 'bonferroni' if applicable
  description: string;        // human-readable: "Statistically significant (p=0.003, N=47, large effect)"
}

export interface Insight {
  module: string;
  title: string;
  description: string;
  severity: InsightSeverity;
  confidence: number;
  affectedPositions: string[];
  suggestion?: string;
  data: Record<string, any>;
  regimeBreakdown?: Record<string, any>;
  // Statistical backing — every insight must include at least one test
  statistics: StatisticalTest[];
  impactScore: number;        // for ranking: higher = show first
  category: InsightCategory;
  isSignificant: boolean;     // true if ALL backing tests are significant
  sampleSize: number;         // total trades this insight is based on
}

export interface InsightDetector {
  name: string;
  /** Don't run with insufficient data — avoid false positives. */
  minimumPositions: number;
  /** Which metric/aggregation fields this detector reads. Informational. */
  dimensions?: string[];
  detect(
    positions: Position[],
    aggregations?: Record<string, AggregationResult>,
  ): Insight[];
}
