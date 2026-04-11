import type { CandleSource, Candle } from '../types';
import type { MarketAPI } from '../../pacifica/rest/market';
import type { CandleInterval } from '../../pacifica/types/market';
import { PacificaRateLimitError } from '../../pacifica/errors';

/**
 * Fetches candles from Pacifica's own kline endpoint.
 *
 * Asset format: Pacifica symbol notation, e.g. 'BTC' (not 'BTCUSDT').
 * Timeframe: matches Pacifica's interval notation — '1d', '1h', '4h', etc.
 *   Supported: '1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'
 *
 * NOTE ON DATA SOURCE:
 * These are Pacifica perpetual mark/index price candles — the same price
 * series that determines your PnL and liquidation on Pacifica. They will
 * match your trade entry/exit prices exactly. This makes them the most
 * accurate source for regime detection in the context of Pacifica trading.
 *
 * The trade-off vs Binance: Pacifica has less historical data than Binance
 * spot. If you need regime history that predates Pacifica's launch, use
 * BinanceCandleSource for the historical backfill and switch to this source
 * for ongoing regime detection.
 *
 * Pagination: Pacifica's /kline endpoint caps each request at 4000 candles
 * ("Normalized time range too large for {interval} interval. Max range: 4000
 * candles"). This source paginates internally by chunking the requested
 * range based on the interval, so callers can ask for arbitrary date ranges
 * and get the full series back.
 */

const INTERVAL_MS: Record<string, number> = {
  '1m':  60_000,
  '3m':  180_000,
  '5m':  300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h':  3_600_000,
  '2h':  7_200_000,
  '4h':  14_400_000,
  '8h':  28_800_000,
  '12h': 43_200_000,
  '1d':  86_400_000,
};

// Stay safely under Pacifica's 4000-candle cap. 3500 leaves headroom for
// boundary inclusivity differences between requests.
const MAX_CANDLES_PER_REQUEST = 3500;

// Polite spacing between paginated chunk requests, so a long history fetch
// doesn't immediately trip Pacifica's rate limiter. The PacificaBaseClient
// already retries 429s with exponential backoff, but a small base delay
// avoids forcing those retries in the first place.
const INTER_CHUNK_DELAY_MS = 200;

// If the underlying client exhausts its 429 retries on a chunk, sleep this
// long and try the chunk again before giving up. Up to MAX_RATE_LIMIT_RETRIES
// extra attempts. Designed to ride out temporary rate-limit windows that are
// longer than the inner client's 1s/2s/4s backoff schedule.
const RATE_LIMIT_RETRY_DELAY_MS = 5000;
const MAX_RATE_LIMIT_RETRIES    = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PacificaCandleSource implements CandleSource {
  readonly name = 'pacifica';

  constructor(private market: MarketAPI) {}

  async fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]> {
    const intervalMs = INTERVAL_MS[timeframe];
    if (intervalMs == null) {
      throw new Error(`PacificaCandleSource: unsupported interval '${timeframe}'`);
    }

    const chunkMs = MAX_CANDLES_PER_REQUEST * intervalMs;
    const endMs = end.getTime();
    const all: Candle[] = [];
    const seenTimestamps = new Set<number>();

    let cursor = start.getTime();
    let isFirstChunk = true;
    while (cursor < endMs) {
      const chunkEnd = Math.min(cursor + chunkMs, endMs);

      // Polite delay between chunks (skip on the very first request).
      if (!isFirstChunk) await sleep(INTER_CHUNK_DELAY_MS);
      isFirstChunk = false;

      const candles = await this.fetchChunkWithRateLimitRetry(asset, timeframe, cursor, chunkEnd);

      for (const k of candles) {
        // Dedupe across chunk boundaries — the API may include the boundary
        // candle on both sides of an adjacent request pair.
        if (seenTimestamps.has(k.t)) continue;
        seenTimestamps.add(k.t);
        all.push({
          timestamp: new Date(k.t),
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
        });
      }

      // Advance past this chunk. +1 ms guarantees we don't re-request the
      // exact boundary; the dedupe set above is the real safety net.
      cursor = chunkEnd + 1;
    }

    // Pacifica returns candles in chronological order per request, but
    // sort once after all chunks are merged just in case.
    return all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Fetch a single chunk, retrying on rate-limit errors with a longer
   * backoff than the inner client's default. Rate limits are transient and
   * unrelated to whether the asset exists, so we don't want them propagating
   * up to the multi-source fetcher (which would falsely fall through to
   * Bybit/Binance).
   */
  private async fetchChunkWithRateLimitRetry(
    asset: string,
    timeframe: string,
    startMs: number,
    endMs: number,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await this.market.getCandles({
          symbol:    asset,
          interval:  timeframe as CandleInterval,
          startTime: startMs,
          endTime:   endMs,
        });
      } catch (err) {
        lastError = err;
        if (!(err instanceof PacificaRateLimitError) || attempt === MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }
        const delay = RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1);
        console.log(
          `[pacifica-candles] rate limit on ${asset} ${timeframe} chunk, ` +
          `retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} after ${delay}ms`,
        );
        await sleep(delay);
      }
    }
    // Unreachable — the loop either returns or throws — but TS wants it.
    throw lastError;
  }
}
