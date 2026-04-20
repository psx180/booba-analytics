/**
 * Compute policy — decides which analytics tiers to run based on what
 * triggered the computation.
 *
 *   fast (2-5s):  Elo, WART, xPnL, entropy, insights, tilt. DB-only.
 *   slow (30s+):  MFE/MAE candle fetch, regime detection. External APIs.
 *
 * Usage:
 *   // Fire and forget from a mutation route
 *   runCompute(wallet, 'mutation', journalId).catch(err =>
 *     console.error('[compute-policy] Background fast compute failed:', err)
 *   );
 *
 *   // Awaited from import route
 *   await runCompute(wallet, 'import', journalId);
 */

import { createAnalyticsService } from './analytics';

type ComputeEvent = 'import' | 'mutation' | 'pageLoad' | 'staleData';
type ComputeTier = 'fast' | 'slow';

const computePolicy: Record<ComputeEvent, ComputeTier[]> = {
  import:    ['fast', 'slow'], // full compute after import
  mutation:  ['fast'],         // only fast after merge/split/annotate/move
  pageLoad:  [],               // use cached results
  staleData: ['slow'],         // user explicitly requests deep analysis
};

export async function runCompute(
  walletAddress: string,
  event: ComputeEvent,
  journalId?: string,
): Promise<{ ran: ComputeTier[]; skipped: ComputeTier[] }> {
  console.log('[compute-policy] runCompute called', event, walletAddress.substring(0, 8));
  const tiers = computePolicy[event];
  const ran: ComputeTier[] = [];
  const skipped: ComputeTier[] = [];

  const service = createAnalyticsService();

  if (tiers.includes('fast')) {
    await service.computeMetrics(walletAddress, journalId, 'fast');
    await service.detectInsights(walletAddress, journalId);
    ran.push('fast');
  } else {
    skipped.push('fast');
  }

  if (tiers.includes('slow')) {
    await service.computeMetrics(walletAddress, journalId, 'slow');
    try {
      const { AdxAtrDetector, RegimeService } = await import('./regime');
      const { getCandleCache, CacheBackedCandleSource } = await import('./candles');
      const detector = new AdxAtrDetector();
      // Route BTC candle fetches through the shared cache. Snapshots stay
      // under the historical 'BTCUSDT' asset label (so existing rows aren't
      // orphaned), but the cache stores under 'BTC' — `mapAsset` strips the
      // USDT suffix before hitting the cache.
      const source = new CacheBackedCandleSource(
        getCandleCache(),
        (asset) => asset.replace(/USDT$/, ''),
      );
      const regimeService = new RegimeService(detector, source);
      const end = new Date();
      const start = new Date(end.getTime() - 365 * 86_400_000);
      await regimeService.computeRegimes('BTCUSDT', '1d', start, end);
      try {
        await regimeService.tagTrades();
        console.log('[compute-policy] tagTrades completed');
      } catch (err) {
        console.error('[compute-policy] tagTrades failed:', err);
      }
    } catch (err) {
      console.error('[compute-policy] Regime computation failed:', err);
    }
    console.log('[compute-policy] Regime detection and tagging complete');
    ran.push('slow');
  } else {
    skipped.push('slow');
  }

  return { ran, skipped };
}
