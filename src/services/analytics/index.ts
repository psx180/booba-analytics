/**
 * Analytics module entry point.
 *
 * Registers all metric computers, aggregators, and insight detectors, and
 * exposes a factory that constructs a ready-to-use AnalyticsService. To add
 * a new module, implement the interface in its file and append it to the
 * matching registry array below — nothing else has to change.
 */

import { prisma } from '../../lib/prisma';
import { AnalyticsService } from './analytics-service';

import type { MetricComputer, Aggregator, InsightDetector } from './types';

// Metrics
import { exitQualityComputer } from './metrics/exit-quality';
import { timingComputer } from './metrics/timing';

// Aggregators
import { performanceAggregator } from './aggregations/performance';
import { equityCurveAggregator } from './aggregations/equity-curve';
import { breakdownAggregator } from './aggregations/breakdown';
import { whatIfAggregator } from './aggregations/what-if';

// Insights
import { exitOptimizerDetector } from './insights/exit-optimizer';
import { dispositionDetector } from './insights/disposition';

export const metricComputers: MetricComputer[] = [
  exitQualityComputer,
  timingComputer,
];

// breakdown and what-if aren't plain Aggregators (they take options), but the
// service knows to route them through aggregate() with the options arg.
export const aggregators: Aggregator[] = [
  performanceAggregator,
  equityCurveAggregator,
  breakdownAggregator as unknown as Aggregator,
  whatIfAggregator as unknown as Aggregator,
];

export const insightDetectors: InsightDetector[] = [
  exitOptimizerDetector,
  dispositionDetector,
];

export function createAnalyticsService(): AnalyticsService {
  return new AnalyticsService(
    metricComputers,
    aggregators,
    insightDetectors,
    prisma as any,
  );
}

export { AnalyticsService };
export type { MetricComputer, Aggregator, InsightDetector } from './types';
export type {
  AggregationResult,
  Insight,
  InsightSeverity,
  Filters,
} from './types';