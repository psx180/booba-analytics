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
import { PacificaClient } from '../pacifica';
import { PacificaCandleSource } from '../regime/candle-sources/pacifica';
import { BybitCandleSource } from '../regime/candle-sources/bybit';
import { BinanceCandleSource } from '../regime/candle-sources/binance';

import type { MetricComputer, Aggregator, InsightDetector } from './types';

// Metrics
import {
  createExitQualityComputer,
  createMultiSourceFetcher,
  type CandleSourceAdapter,
} from './metrics/exit-quality';
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

/**
 * Pacifica-native assets that don't exist on Bybit or Binance under any
 * symbol mapping. Listing them keeps Bybit/Binance from making doomed
 * requests for them — the multi-source fetcher just falls through.
 *
 * Anything in here is a Pacifica perp that has no centralized-exchange
 * spot or perp listing (memes, prediction markets, etc.). Bybit/Binance
 * adapters return null for these so the fetcher skips straight to the
 * next source. The list is intentionally conservative — if an asset is
 * listed on Bybit later, the fetcher will still find it via the trial
 * fetch path; this is purely a request-saver.
 */
const PACIFICA_NATIVE_ONLY = new Set([
  'PIPPIN', 'FARTCOIN', 'PUMP', 'ASTER', 'WLFI', 'XPL',
  'BP', '2Z', 'MEGA', 'LIT', 'MON', 'PENGU',
  // kPEPE / kBONK use Pacifica's "k" (×1000) prefix that CEXes don't follow
  'kPEPE', 'kBONK',
  // Equity/commodity/forex perps — only on Pacifica
  'NVDA', 'TSLA', 'GOOGL', 'PLTR', 'HOOD', 'CRCL',
  'SP500', 'XAU', 'XAG', 'PLATINUM', 'COPPER', 'NATGAS', 'CL',
  'EURUSD', 'USDJPY', 'PAXG', 'URNM',
]);

/** Pacifica's /kline takes the bare asset symbol — no mapping needed. */
function pacificaToSymbol(asset: string): string | null {
  return asset;
}

/** Bybit/Binance use 'BTCUSDT', 'ETHUSDT' etc. Strip any '-PERP' suffix. */
function ceXToUsdtSymbol(asset: string): string | null {
  if (PACIFICA_NATIVE_ONLY.has(asset)) return null;
  const base = asset.split('-')[0].toUpperCase();
  return `${base}USDT`;
}

// Plumb PF_API_KEY through so analytics candle fetches get the higher
// rate-limit ceiling. Without this the public limit kicks in fast — a
// single asset's paginated 1m fetch can blow it out and cascade into
// useless Bybit/Binance fallthroughs.
const pacificaClient = new PacificaClient({
  apiConfigKey: process.env.PF_API_KEY,
});
if (process.env.PF_API_KEY) {
  console.log('[analytics] Pacifica candle source using PF_API_KEY for raised rate limits');
}
const pacificaCandleSource = new PacificaCandleSource(pacificaClient.market);
const bybitCandleSource    = new BybitCandleSource();
const binanceCandleSource  = new BinanceCandleSource();

const candleAdapters: CandleSourceAdapter[] = [
  { name: 'pacifica', toSymbol: pacificaToSymbol, source: pacificaCandleSource },
  { name: 'bybit',    toSymbol: ceXToUsdtSymbol,  source: bybitCandleSource },
  { name: 'binance',  toSymbol: ceXToUsdtSymbol,  source: binanceCandleSource },
];

const exitQualityComputer = createExitQualityComputer(
  createMultiSourceFetcher(candleAdapters),
);

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