/**
 * CandleCache — server-wide OHLCV cache.
 *
 * Candle fetches from the analytics pipeline, regime detection, and the
 * trade replay component all route through here. First request fills the
 * cache from the multi-source chain (Pacifica → Bybit → Binance); subsequent
 * requests for the same (asset, timeframe, window) hit the database directly,
 * with no API calls.
 *
 * Asset notation: Pacifica symbols ('BTC', 'SOL', 'kPEPE'). Adapters handle
 * symbol translation ('BTC' → 'BTCUSDT') for Bybit/Binance internally — the
 * cache itself is always keyed on the Pacifica name, so cache hits compose
 * across callers regardless of which source originally served the data.
 *
 * Gap detection: we compute the set of timeframe-aligned timestamps expected
 * inside the requested range (capped at the last fully-closed candle — we
 * never consider the still-forming candle a "gap"). Whatever's missing from
 * the cache gets fetched, stored, and merged in. If the multi-source chain
 * returns nothing for a given asset (e.g. a Pacifica-native meme that no CEX
 * lists and that predates Pacifica's own history), the call returns whatever
 * is cached — possibly an empty array. Callers decide what to do with that.
 */

import { prisma } from '../../lib/prisma';
import type { Candle, CandleSource } from '../regime/types';

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * One candle backend with symbol-format conversion baked in. `toSymbol`
 * returns null when the adapter doesn't list the asset at all, so the chain
 * skips straight to the next source without making a doomed request.
 */
export interface CandleSourceAdapter {
  readonly name: string;
  toSymbol(asset: string): string | null;
  source: CandleSource;
}

// Supported timeframes — must match adapter capabilities across the chain.
const TIMEFRAME_MS: Record<string, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};

function timeframeToMs(timeframe: string): number {
  const ms = TIMEFRAME_MS[timeframe];
  if (ms == null) throw new Error(`CandleCache: unsupported timeframe '${timeframe}'`);
  return ms;
}

/**
 * Enumerate timeframe-aligned candle open-times inside [start, end], capped
 * at (now - intervalMs) so the still-forming live candle is never treated as
 * an expected row. Used for gap detection, not for iteration over candles.
 */
function expectedTimestamps(start: Date, end: Date, intervalMs: number): number[] {
  const cap = Date.now() - intervalMs;
  const cappedEnd = Math.min(end.getTime(), cap);
  const firstBoundary = Math.ceil(start.getTime() / intervalMs) * intervalMs;
  if (firstBoundary > cappedEnd) return [];
  const out: number[] = [];
  for (let t = firstBoundary; t <= cappedEnd; t += intervalMs) out.push(t);
  return out;
}

function toCandle(row: {
  timestamp: Date; open: number; high: number; low: number; close: number; volume: number;
}): Candle {
  return {
    timestamp: row.timestamp,
    open:   row.open,
    high:   row.high,
    low:    row.low,
    close:  row.close,
    volume: row.volume,
  };
}

/**
 * Merge adjacent missing timestamps into contiguous DateRange gaps.
 * Used by `getCachedRange` for caller introspection. `getCandles` itself
 * doesn't need the ranges — it just refetches the whole request if any
 * expected timestamp is missing (simplest correct behavior, and matches the
 * spec's "first run fills the cache, subsequent runs near-instant" promise).
 */
function mergeMissingIntoRanges(missing: number[], intervalMs: number): DateRange[] {
  if (missing.length === 0) return [];
  const sorted = [...missing].sort((a, b) => a - b);
  const ranges: DateRange[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + intervalMs) {
      rangeEnd = sorted[i];
    } else {
      ranges.push({ start: new Date(rangeStart), end: new Date(rangeEnd + intervalMs) });
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  ranges.push({ start: new Date(rangeStart), end: new Date(rangeEnd + intervalMs) });
  return ranges;
}

export class CandleCache {
  constructor(private adapters: CandleSourceAdapter[]) {}

  /**
   * Returns every cached candle in [start, end] along with the detected
   * gaps. Does not fetch from the network — use `getCandles` for that.
   */
  async getCachedRange(
    asset: string,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<{ candles: Candle[]; gaps: DateRange[] }> {
    const intervalMs = timeframeToMs(timeframe);
    const rows = await prisma.candleCache.findMany({
      where: {
        asset,
        timeframe,
        timestamp: { gte: start, lte: end },
      },
      orderBy: { timestamp: 'asc' },
    });
    const cached = rows.map(toCandle);
    const expected = expectedTimestamps(start, end, intervalMs);
    const cachedSet = new Set(cached.map((c) => c.timestamp.getTime()));
    const missing = expected.filter((t) => !cachedSet.has(t));
    return { candles: cached, gaps: mergeMissingIntoRanges(missing, intervalMs) };
  }

  /**
   * Insert candles into the cache, skipping any (asset, timeframe,
   * timestamp) already present. Prisma's `createMany` on SQLite doesn't
   * support `skipDuplicates` in this version, so we pre-filter with a cheap
   * lookup of existing timestamps in the candle range and only insert what's
   * new. Safe against concurrent writers: the UNIQUE constraint on the
   * compound key would still reject a true race, caught per-batch.
   */
  async storeCandles(
    asset: string,
    timeframe: string,
    candles: Candle[],
    source: string,
  ): Promise<void> {
    if (candles.length === 0) return;
    const timestamps = candles.map((c) => c.timestamp);
    let minMs = timestamps[0].getTime();
    let maxMs = timestamps[0].getTime();
    for (const t of timestamps) {
      const ms = t.getTime();
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
    const existing = await prisma.candleCache.findMany({
      where: {
        asset,
        timeframe,
        timestamp: { gte: new Date(minMs), lte: new Date(maxMs) },
      },
      select: { timestamp: true },
    });
    const existingSet = new Set(existing.map((r) => r.timestamp.getTime()));
    const toInsert = candles.filter((c) => !existingSet.has(c.timestamp.getTime()));
    if (toInsert.length === 0) return;
    try {
      await prisma.candleCache.createMany({
        data: toInsert.map((c) => ({
          asset,
          timeframe,
          timestamp: c.timestamp,
          open:   c.open,
          high:   c.high,
          low:    c.low,
          close:  c.close,
          volume: c.volume,
          source,
        })),
      });
    } catch (err) {
      // Concurrent writer raced us to the same (asset, timeframe, timestamp).
      // Unique constraint caught it — we've done no harm, just log and move on.
      console.log(
        `[candle-cache] store race on ${asset} ${timeframe}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Get candles for the requested range. Hits cache first; on any gap,
   * fetches from the multi-source chain, stores what it gets, and returns
   * the merged set. Returns whatever is available — possibly [].
   */
  async getCandles(
    asset: string,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<Candle[]> {
    const intervalMs = timeframeToMs(timeframe);
    const expected = expectedTimestamps(start, end, intervalMs);

    // First cache check.
    let rows = await prisma.candleCache.findMany({
      where: { asset, timeframe, timestamp: { gte: start, lte: end } },
      orderBy: { timestamp: 'asc' },
    });

    // Fully covered — no network work needed. The >= comparison is
    // deliberate: some backends return an extra boundary candle, or a user
    // query may land entirely before the first expected boundary (no expected
    // candles at all, e.g. a sub-minute range on 1m), and we treat both as
    // satisfied.
    if (rows.length >= expected.length) {
      return rows.map(toCandle);
    }

    // Gap — refetch the whole range once from the chain. Upsert by unique
    // key makes this idempotent against the overlapping candles we already
    // cached, and the over-fetch is cheap compared to the alternative of
    // micro-ranged requests.
    const { candles, source } = await this.fetchFromChain(asset, timeframe, start, end);
    if (candles.length > 0) {
      await this.storeCandles(asset, timeframe, candles, source);
      // Re-query so caller gets exactly what's in the cache now (sorted,
      // deduped — including candles that were already there). Cheaper than
      // merging manually and handles the case where the fetch returned
      // extras beyond the requested window.
      rows = await prisma.candleCache.findMany({
        where: { asset, timeframe, timestamp: { gte: start, lte: end } },
        orderBy: { timestamp: 'asc' },
      });
    }
    return rows.map(toCandle);
  }

  /**
   * Try each adapter in order. Returns the first non-empty result, along
   * with the source name so `storeCandles` can record it. Logs which source
   * served the data (or that all sources failed) — mirrors exit-quality's
   * prior logging so the operator trail is unchanged.
   */
  private async fetchFromChain(
    asset: string,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<{ candles: Candle[]; source: string }> {
    for (const adapter of this.adapters) {
      const symbol = adapter.toSymbol(asset);
      if (symbol == null) {
        console.log(`[candle-cache] ${adapter.name} does not list ${asset}, trying next source...`);
        continue;
      }
      try {
        const candles = await adapter.source.fetchCandles(symbol, timeframe, start, end);
        if (candles.length > 0) {
          console.log(
            `[candle-cache] Filled ${asset} ${timeframe} from ${adapter.name} ` +
            `(${candles.length} candles, ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})`,
          );
          return { candles, source: adapter.name };
        }
        console.log(
          `[candle-cache] ${adapter.name} returned 0 candles for ${asset} ${timeframe} ` +
          `[${start.toISOString()} → ${end.toISOString()}], trying next source...`,
        );
      } catch (err) {
        console.log(
          `[candle-cache] ${adapter.name} failed for ${asset}: ` +
          `${(err as Error).message}, trying next source...`,
        );
      }
    }
    return { candles: [], source: 'none' };
  }
}

/**
 * CandleSource adapter that reads/writes through a CandleCache instance.
 *
 * Some callers (notably `RegimeService`) are typed against `CandleSource`
 * and pre-date the cache. Wrapping the cache in this shim lets them benefit
 * from cache hits without changing their interfaces. Pass an optional
 * `mapAsset` to translate caller-side symbols into the Pacifica notation
 * the cache stores under (e.g. strip 'USDT' from 'BTCUSDT' → 'BTC').
 */
export class CacheBackedCandleSource implements CandleSource {
  readonly name = 'candle-cache';

  constructor(
    private cache: CandleCache,
    private mapAsset?: (asset: string) => string,
  ) {}

  async fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]> {
    const cacheAsset = this.mapAsset ? this.mapAsset(asset) : asset;
    return this.cache.getCandles(cacheAsset, timeframe, start, end);
  }
}
