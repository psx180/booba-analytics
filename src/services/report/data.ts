/**
 * Internal bundle of pre-loaded analytics that section generators consume.
 *
 * The orchestrator loads everything in parallel ONCE, then hands this
 * frozen bundle to each pure section generator. Section files never touch
 * the database or fetch anything — all I/O happens in report-service.ts.
 */

import type { Position } from '../../../generated/prisma/client';
import type { Filters, Insight } from '../analytics/types';
import type { RiskMetrics } from '../analytics/metrics/risk-metrics';
import type { EloResult } from '../analytics/metrics/elo';
import type { WartResult } from '../analytics/metrics/wart';
import type { ConvergenceResult } from '../analytics/convergence';
import type { MonteCarloResult } from '../analytics/monte-carlo';
import type { WalkForwardResult } from '../analytics/walk-forward';
import type { TiltEpisode } from '../analytics/tilt/types';
import type { AggregationResult } from '../analytics/types';
import type { EquityPoint, DrawdownSummary } from '../analytics/equity/types';

export interface ReportData {
  walletAddress: string;
  filters: Filters | null;
  positions: Position[];
  /** Closed positions only — most metrics ignore open positions. */
  closedPositions: Position[];
  /** generatedAt set by the orchestrator. */
  generatedAt: Date;
  startingCapital: number;
  equityCurve: EquityPoint[];
  drawdownSummary: DrawdownSummary;
  riskMetrics: RiskMetrics;
  eloResult: EloResult;
  wartResult: WartResult;
  convergence: ConvergenceResult;
  /** Null when slow-tier hasn't run, sample is too small, or detector failed. */
  monteCarlo: MonteCarloResult | null;
  /** Null when fewer than the walk-forward minimum window count. */
  walkForward: WalkForwardResult | null;
  storedInsights: Insight[];
  insightsLastComputedAt: Date | null;
  /** Latest BTC regime snapshot if available. */
  currentRegime: string | null;
  tiltEpisodes: TiltEpisode[];
  /** breakdowns.regime / breakdowns.tradeType maps from the breakdown aggregator. */
  regimeBreakdown: Record<string, Record<string, any>>;
  tradeTypeBreakdown: Record<string, Record<string, any>>;
  /** Pre-computed performance aggregator output — winRate / averageWin / averageLoss / etc. */
  performance: AggregationResult;
}
