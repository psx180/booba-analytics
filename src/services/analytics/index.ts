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
import { getCandleCache } from '../candles';

import type { MetricComputer, Aggregator, InsightDetector } from './types';

// Metrics
import { createExitQualityComputer } from './metrics/exit-quality';
import { timingComputer } from './metrics/timing';
import { xpnlComputer } from './metrics/xpnl';
import { eloComputer } from './metrics/elo';

// Aggregators
import { performanceAggregator } from './aggregations/performance';
import { equityCurveAggregator } from './aggregations/equity-curve';
import { breakdownAggregator } from './aggregations/breakdown';
import { whatIfAggregator } from './aggregations/what-if';

// Insights
import { exitOptimizerDetector }    from './insights/exit-optimizer';
import { dispositionDetector }      from './insights/disposition';
import { revengeTradingDetector }   from './insights/revenge-trading';
import { overtradingDetector }      from './insights/overtrading';
import { sizeEscalationDetector }   from './insights/size-escalation';
import { timeOfDayEdgeDetector }    from './insights/time-of-day-edge';
import { regimeMismatchDetector }   from './insights/regime-mismatch';
import { streakBehaviorDetector }   from './insights/streak-behavior';
import { holdTimeOptimizerDetector } from './insights/hold-time-optimizer';
import { outlierDependencyDetector } from './insights/outlier-dependency';
import { sizingAnalysisDetector }    from './insights/sizing-analysis';
import { tiltEpisodesDetector }      from './insights/tilt-episodes';
import { mlPatternsDetector }        from './insights/ml-patterns';
import { combinatorialSearchDetector } from './insights/combinatorial-search';
import { xpnlInsightDetector }       from './insights/xpnl-insight';
import { entropyInsightDetector }    from './insights/entropy-insight';
import { wartInsightDetector }       from './insights/wart-insight';

// Candle fetches route through the shared CandleCache (DB-backed, server-
// wide). First compute run fills the cache; subsequent runs hit it directly.
// The multi-source fallback chain (Pacifica → Bybit → Binance) and the
// symbol-mapping logic both live inside the cache module.
if (process.env.PF_API_KEY) {
  console.log('[analytics] Pacifica candle source using PF_API_KEY for raised rate limits');
}
const candleCache = getCandleCache();
const exitQualityComputer = createExitQualityComputer({
  fetch: (asset, timeframe, start, end) =>
    candleCache.getCandles(asset, timeframe, start, end),
});

export const metricComputers: MetricComputer[] = [
  exitQualityComputer,
  timingComputer,
  xpnlComputer,
  eloComputer,
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
  revengeTradingDetector,
  overtradingDetector,
  sizeEscalationDetector,
  timeOfDayEdgeDetector,
  regimeMismatchDetector,
  streakBehaviorDetector,
  holdTimeOptimizerDetector,
  outlierDependencyDetector,
  sizingAnalysisDetector,
  tiltEpisodesDetector,
  mlPatternsDetector,
  combinatorialSearchDetector,
  xpnlInsightDetector,
  entropyInsightDetector,
  wartInsightDetector,
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
  InsightCategory,
  StatisticalTest,
  Filters,
} from './types';