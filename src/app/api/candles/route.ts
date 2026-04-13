/**
 * GET /api/candles?asset=BTC&timeframe=1h&start=ISO&end=ISO
 *
 * Read-through to the server-wide CandleCache. Auth is enforced via
 * `withAuth` (we gate who can trigger a cache fill), but the candle data
 * itself is shared — no wallet scoping. First request for a given (asset,
 * timeframe, range) warms the cache from Pacifica → Bybit → Binance;
 * subsequent calls for the same range serve straight from the DB.
 *
 * Returns `{ candles: [{ timestamp, open, high, low, close, volume }] }`.
 * Empty array is a valid response for Pacifica-native assets (PIPPIN etc.)
 * that no backend has candle data for — the UI surfaces this as
 * "Replay not available — no price data for this asset".
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { getCandleCache } from '@/services/candles';

const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);

// Cap on how much history a single request can ask for, per timeframe. Keeps
// a malicious or buggy caller from triggering a multi-year 1m paginated
// backfill. Numbers match the largest window the trade replay UI will ever
// need (longest historical trade + 20 context candles + a safety margin).
const MAX_CANDLES_PER_REQUEST: Record<string, number> = {
  '1m':  1500,   // ~25h
  '5m':  1500,   // ~5d
  '15m': 1500,   // ~15d
  '1h':  1500,   // ~62d
  '4h':  1500,   // ~250d
  '1d':  1500,   // ~4y
};

const TIMEFRAME_MS: Record<string, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};

export async function GET(req: NextRequest) {
  return withAuth(req, async () => {
    const sp = req.nextUrl.searchParams;
    const asset = sp.get('asset');
    const timeframe = sp.get('timeframe');
    const startParam = sp.get('start');
    const endParam = sp.get('end');

    if (!asset || !timeframe || !startParam || !endParam) {
      return NextResponse.json(
        { error: 'asset, timeframe, start, and end are required' },
        { status: 400 },
      );
    }

    if (!ALLOWED_TIMEFRAMES.has(timeframe)) {
      return NextResponse.json(
        { error: `timeframe must be one of ${[...ALLOWED_TIMEFRAMES].join(', ')}` },
        { status: 400 },
      );
    }

    const start = new Date(startParam);
    const end = new Date(endParam);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ error: 'start and end must be ISO dates' }, { status: 400 });
    }
    if (end.getTime() <= start.getTime()) {
      return NextResponse.json({ error: 'end must be after start' }, { status: 400 });
    }

    const intervalMs = TIMEFRAME_MS[timeframe];
    const estimatedCandles = Math.ceil((end.getTime() - start.getTime()) / intervalMs);
    const maxCandles = MAX_CANDLES_PER_REQUEST[timeframe];
    if (estimatedCandles > maxCandles) {
      return NextResponse.json(
        { error: `range too wide: ${estimatedCandles} candles requested, max ${maxCandles} for ${timeframe}` },
        { status: 400 },
      );
    }

    const cache = getCandleCache();
    const candles = await cache.getCandles(asset, timeframe, start, end);

    return NextResponse.json({
      candles: candles.map((c) => ({
        timestamp: c.timestamp.toISOString(),
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.volume,
      })),
    });
  });
}
