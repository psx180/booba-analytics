/**
 * seed-candles.ts — Pre-populate the candle cache for demo trade generation.
 *
 * Fetches 14 days of historical candles for BTC, ETH, SOL at 1m, 5m, 1h
 * from the multi-source chain (Pacifica → Bybit → Binance) and stores them
 * in the CandleCache DB table. Subsequent seed runs hit the DB directly.
 *
 * Also runs BTC 1h regime detection so the trade simulator can look up which
 * market regime was in effect at each simulated entry time.
 *
 * Usage (standalone):
 *   npx tsx src/scripts/seed-candles.ts
 */

import { getCandleCache, CacheBackedCandleSource } from '../services/candles';
import { RegimeService, AdxAtrDetector } from '../services/regime';
import { prisma } from '../lib/prisma';

const ASSETS     = ['BTC', 'ETH', 'SOL'];
const TIMEFRAMES = ['1m', '5m', '1h'];
const DAYS_BACK  = 14;

// ─── Public API (re-used by seed-demo.ts) ─────────────────────────────────────

export async function populateCandles(): Promise<void> {
  const cache = getCandleCache();
  const now   = new Date();
  const start = new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

  for (const asset of ASSETS) {
    for (const timeframe of TIMEFRAMES) {
      // getCandles() auto-fetches from Pacifica/Bybit/Binance on a cache miss
      // and stores whatever it gets — so this is both a fetch and a store.
      const candles = await cache.getCandles(asset, timeframe, start, now);
      console.log(`[seed] Fetched ${candles.length} ${timeframe} candles for ${asset}`);
    }
  }
}

export async function runRegimeDetection(): Promise<void> {
  const cache  = getCandleCache();
  const now    = new Date();
  const start  = new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

  // CacheBackedCandleSource wraps the shared DB cache so regime detection
  // reads from local storage rather than hitting an external API again.
  const candleSource = new CacheBackedCandleSource(cache);
  const detector     = new AdxAtrDetector();
  const service      = new RegimeService(detector, candleSource);

  const { computed, skipped } = await service.computeRegimes('BTC', '1h', start, now);
  console.log(`[seed] Regime snapshots: ${computed} computed, ${skipped} already existed`);
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    console.log('[seed] Populating candle cache...');
    await populateCandles();

    console.log('[seed] Running regime detection...');
    await runRegimeDetection();

    console.log('[seed] Done.');
  })()
    .catch((err) => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
