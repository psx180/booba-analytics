/**
 * Exit-quality metrics — MFE, MAE, exit efficiency, money left on table.
 *
 *   mfePrice          — best price the position reached during its hold
 *   mfePnl            — best $ P&L the position would have shown at MFE (≥ 0)
 *   maePrice          — worst price the position reached during its hold
 *   maePnl            — worst $ P&L the position would have shown at MAE (≤ 0)
 *   exitEfficiency    — actual price move captured / max favorable move
 *                       1.0 = perfect exit at the top
 *                       0.5 = captured half the move
 *                       0.0 = exited at entry
 *                       <0  = exited in the red
 *   moneyLeftOnTable  = MFE dollar P&L − actual dollar P&L (clamped at 0)
 *   maeRatio          = |MAE dollar P&L| / |actual dollar P&L|
 *                       High values → took a lot of heat for the gain realized.
 *
 * ─── Why a factory + computeAll ────────────────────────────────────────────
 *
 * Computing MFE/MAE requires fetching price candles for every closed position
 * over its hold window. Per-position `compute()` can't do that — it's sync,
 * pure, and has no I/O. So this module exports a factory:
 *
 *     createExitQualityComputer(fetcher) → MetricComputer
 *
 * The returned computer implements `computeAll(positions)` which:
 *   1. Filters to closed positions with valid timestamps and entry/size
 *   2. Picks a candle timeframe per position based on hold duration
 *      (1m for <15min trades, 15m for <4h, 1h for ≥4h)
 *   3. Buckets positions by (asset, timeframe), computes the union date range
 *      for each bucket, and fetches once
 *   4. Calls the injected fetcher (normally CandleCache, which serves from
 *      its local DB cache and falls through Pacifica → Bybit → Binance on a
 *      miss). Assets with no candle data anywhere return [] and are skipped
 *      without failing the pipeline.
 *   5. Slices each bucket's candles to each position's exact entry-to-exit
 *      window, then computes MFE/MAE/exitEfficiency/moneyLeftOnTable/maeRatio
 *
 * The per-position `compute()` is kept as a no-op pass-through so the metric
 * still type-checks against MetricComputer for analytics-service.ts's loop.
 */

import type { MetricComputer, Position, Candle } from './base';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Thin contract over whatever actually produces candles. We used to bundle
 * a multi-source fallback chain inline here, but it moved to CandleCache so
 * every caller (MFE/MAE, regime, trade replay) hits the same shared cache.
 * `CandleCache.getCandles` matches this shape, so analytics passes it in
 * directly.
 */
export interface CandleFetcher {
  fetch(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]>;
}

// ─── Factory ──────────────────────────────────────────────────────────────

const HOLD_15_MIN_SEC = 15 * 60;
const HOLD_4_HOUR_SEC = 4 * 60 * 60;

const TIMEFRAME_MS: Record<string, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
};

/** 5-minute pre-entry / post-exit buffer so the entry candle is always covered. */
const WINDOW_BUFFER_MS = 5 * 60 * 1000;

/**
 * Pacifica's /kline endpoint has an undocumented minimum range requirement:
 * the request span must be wider than ~60 candles for 1m, ~20 candles for 1h
 * (and similar thresholds for other intervals). When the bucket's natural
 * range is below that threshold, the API rejects the request with the
 * misleading error "start_time must be less than end_time" — even when start
 * is plainly less than end.
 *
 * Solution: pad every bucket range to at least 120 candles wide AND at least
 * 24 hours wide. The per-position slice filter throws away any candles that
 * fall outside the actual entry-to-exit window, so over-fetching is harmless
 * to the computed MFE/MAE.
 */
const PACIFICA_MIN_CANDLES_PER_REQUEST = 120;
const PACIFICA_MIN_RANGE_MS = 24 * 60 * 60 * 1000;

/** Pick the candle timeframe to use for a position based on its hold duration. */
function pickTimeframe(holdSeconds: number | null): '1m' | '15m' | '1h' {
  if (holdSeconds == null) return '15m';
  if (holdSeconds < HOLD_15_MIN_SEC) return '1m';
  if (holdSeconds < HOLD_4_HOUR_SEC) return '15m';
  return '1h';
}

interface BucketKey {
  asset: string;
  timeframe: '1m' | '15m' | '1h';
}

interface Bucket {
  asset: string;
  timeframe: '1m' | '15m' | '1h';
  positions: Position[];
  startMs: number;
  endMs: number;
}

export function createExitQualityComputer(
  fetcher: CandleFetcher,
): MetricComputer {
  return {
    name: 'exit-quality',
    tier: 'slow' as const,
    requiredFields: [
      'status',
      'direction',
      'averageEntryPrice',
      'averageExitPrice',
      'totalSize',
      'aggregatePnl',
      'firstEntryTime',
      'lastExitTime',
      'holdTimeSeconds',
    ],

    /**
     * No-op per-position computer. The real work happens in computeAll.
     * Kept so the analytics service can still loop over compute() during
     * the write phase without special-casing this metric — the loop will
     * just merge the empty result, then merge the batch result on top.
     */
    compute(): Record<string, number | string | null> {
      return {};
    },

    async computeAll(positions: Position[]) {
      const result = new Map<string, Record<string, number | string | null>>();

      // ─── 1. Filter to positions that need (and can have) MFE/MAE ───────
      const eligible = positions.filter((p) => {
        if (p.status !== 'closed') return false;
        if (!p.firstEntryTime || !p.lastExitTime) return false;
        if (p.averageEntryPrice == null || p.averageEntryPrice === 0) return false;
        if (p.totalSize == null || p.totalSize === 0) return false;
        return true;
      });

      console.log(
        `[exit-quality] computeAll: ${eligible.length}/${positions.length} positions ` +
        `eligible for MFE/MAE computation`,
      );

      if (eligible.length === 0) return result;

      // ─── 2. Bucket by (asset, timeframe) and compute union ranges ──────
      const buckets = new Map<string, Bucket>();
      for (const p of eligible) {
        const timeframe = pickTimeframe(p.holdTimeSeconds);
        const key = `${p.asset}::${timeframe}`;
        const startMs = p.firstEntryTime!.getTime() - WINDOW_BUFFER_MS;
        const endMs   = p.lastExitTime!.getTime()   + WINDOW_BUFFER_MS;

        const existing = buckets.get(key);
        if (existing) {
          existing.positions.push(p);
          if (startMs < existing.startMs) existing.startMs = startMs;
          if (endMs   > existing.endMs)   existing.endMs   = endMs;
        } else {
          buckets.set(key, {
            asset: p.asset,
            timeframe,
            positions: [p],
            startMs,
            endMs,
          });
        }
      }

      console.log(
        `[exit-quality] computeAll: ${buckets.size} (asset, timeframe) buckets`,
      );

      // ─── 3. Per-bucket fetch + per-position MFE/MAE ────────────────────
      let computed = 0;
      let skippedNoCandles = 0;

      for (const bucket of buckets.values()) {
        // Pad the request range so it always exceeds Pacifica's minimum span.
        // The slice filter still uses each position's exact entry/exit window,
        // so over-fetching is purely a request-shape concern.
        const intervalMs = TIMEFRAME_MS[bucket.timeframe];
        const minRangeMs = Math.max(
          PACIFICA_MIN_RANGE_MS,
          PACIFICA_MIN_CANDLES_PER_REQUEST * intervalMs,
        );
        const naturalRange = bucket.endMs - bucket.startMs;
        const padPerSide = naturalRange < minRangeMs
          ? Math.ceil((minRangeMs - naturalRange) / 2)
          : 0;
        const fetchStartMs = bucket.startMs - padPerSide;
        const fetchEndMs   = bucket.endMs   + padPerSide;

        const start = new Date(fetchStartMs);
        const end   = new Date(fetchEndMs);
        const days  = ((fetchEndMs - fetchStartMs) / 86_400_000).toFixed(1);

        console.log(
          `[exit-quality] Fetching candles for ${bucket.asset} (${bucket.positions.length} positions, ` +
          `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}, ${days}d) ` +
          `at ${bucket.timeframe}...`,
        );

        // For very long ranges at fine timeframes the union fetch would be
        // wasteful (1m × 6 months = 260k candles, ~75 paginated requests).
        // Fall back to per-position fetches in that case.
        const estimatedCandles = (fetchEndMs - fetchStartMs) / intervalMs;
        const useUnionFetch = estimatedCandles <= 50_000;

        if (useUnionFetch) {
          const candles = await fetcher.fetch(bucket.asset, bucket.timeframe, start, end);
          if (candles.length === 0) {
            console.warn(
              `[exit-quality] No candle data available for ${bucket.asset} — ` +
              `MFE/MAE will not be computed for ${bucket.positions.length} position(s)`,
            );
            skippedNoCandles += bucket.positions.length;
            continue;
          }
          for (const p of bucket.positions) {
            const slice = sliceCandlesForPosition(candles, p);
            const updates = computeMfeMaeUpdates(p, slice);
            if (updates) {
              result.set(p.id, updates);
              computed++;
            } else {
              skippedNoCandles++;
            }
          }
        } else {
          // Per-position fallback for huge ranges.
          console.log(
            `[exit-quality]   union range too large (~${estimatedCandles.toFixed(0)} candles), ` +
            `falling back to per-position fetches`,
          );
          for (const p of bucket.positions) {
            const naturalStart = p.firstEntryTime!.getTime() - WINDOW_BUFFER_MS;
            const naturalEnd   = p.lastExitTime!.getTime()   + WINDOW_BUFFER_MS;
            const naturalRange = naturalEnd - naturalStart;
            const posPad = naturalRange < minRangeMs
              ? Math.ceil((minRangeMs - naturalRange) / 2)
              : 0;
            const posStart = new Date(naturalStart - posPad);
            const posEnd   = new Date(naturalEnd   + posPad);
            const candles  = await fetcher.fetch(bucket.asset, bucket.timeframe, posStart, posEnd);
            if (candles.length === 0) {
              skippedNoCandles++;
              continue;
            }
            const slice  = sliceCandlesForPosition(candles, p);
            const updates = computeMfeMaeUpdates(p, slice);
            if (updates) {
              result.set(p.id, updates);
              computed++;
            } else {
              skippedNoCandles++;
            }
          }
        }
      }

      console.log(
        `[exit-quality] Computed MFE/MAE for ${computed}/${eligible.length} positions ` +
        `(${skippedNoCandles} skipped — unsupported assets or empty candle slices)`,
      );

      return result;
    },
  };
}

// ─── Per-position math ────────────────────────────────────────────────────

function sliceCandlesForPosition(candles: Candle[], position: Position): Candle[] {
  const startMs = position.firstEntryTime!.getTime();
  const endMs   = position.lastExitTime!.getTime();

  const strict = candles.filter((c) => {
    const t = c.timestamp.getTime();
    return t >= startMs && t <= endMs;
  });
  if (strict.length > 0) return strict;

  // Sub-candle hold time (e.g. a 30-second scalp on 1m candles): no candle
  // open-time falls strictly inside [entry, exit]. Bracket the trade with the
  // candles immediately before entry and after exit so we still get an
  // approximate high/low for the period the position was open. The candles
  // are pre-sorted chronologically by the source, so a linear scan suffices.
  let before: Candle | undefined;
  for (const c of candles) {
    if (c.timestamp.getTime() <= startMs) before = c;
    else break;
  }
  const after = candles.find((c) => c.timestamp.getTime() >= endMs);

  const fallback: Candle[] = [];
  if (before) fallback.push(before);
  if (after && (!before || after.timestamp.getTime() !== before.timestamp.getTime())) {
    fallback.push(after);
  }
  return fallback;
}

/**
 * Returns the per-position update payload, or null if the slice was empty
 * (no candles fall inside this position's hold window — likely a sub-minute
 * trade we can't resolve). Also computes the dependent metrics
 * (exitEfficiency, moneyLeftOnTable, maeRatio).
 */
function computeMfeMaeUpdates(
  position: Position,
  slice: Candle[],
): Record<string, number | null> | null {
  if (slice.length === 0) {
    console.log(
      `[exit-quality] position ${position.id} (${position.asset} ${position.direction}): ` +
      `no candles in window [${position.firstEntryTime?.toISOString()} → ` +
      `${position.lastExitTime?.toISOString()}], skipping`,
    );
    return null;
  }

  const entry = position.averageEntryPrice!;
  const size  = position.totalSize!;
  const dir   = position.direction;

  // Raw extremes from the candle slice — high is max favorable for longs and
  // max adverse for shorts; low is the inverse.
  const highestHigh = Math.max(...slice.map((c) => c.high));
  const lowestLow   = Math.min(...slice.map((c) => c.low));

  // MFE/MAE are EXCURSIONS from entry, not just extreme prices. If the trade
  // never went favorable (or never went adverse) during its hold, the
  // corresponding excursion is zero — represented by clamping the extreme to
  // the entry price. Without this clamp a trade that went straight against
  // the position would report a negative mfePnl (impossible by definition).
  // The spec is explicit: "mfePnl is always ≥ 0 (best case), maePnl is
  // always ≤ 0 (worst case)".
  const mfePrice = dir === 'long'
    ? Math.max(highestHigh, entry)
    : Math.min(lowestLow,   entry);

  const maePrice = dir === 'long'
    ? Math.min(lowestLow,   entry)
    : Math.max(highestHigh, entry);

  const mfePnl = dir === 'long'
    ? (mfePrice - entry) * size
    : (entry - mfePrice) * size;

  const maePnl = dir === 'long'
    ? (maePrice - entry) * size
    : (entry - maePrice) * size;

  const updates: Record<string, number | null> = {
    mfePrice: round(mfePrice, 6),
    mfePnl:   round(mfePnl, 2),
    maePrice: round(maePrice, 6),
    maePnl:   round(maePnl, 2),
    exitEfficiency:   null,
    moneyLeftOnTable: null,
    maeRatio:         null,
  };

  // ── Exit efficiency — only meaningful for winning trades ──────────────
  // Per spec: "actualPnl / mfePnl, for winners only, 0-1 range, how much of
  // the available profit was captured." Computing it on losers produces
  // huge negative percentages (loser exited deep red after a tiny favorable
  // blip) that wreck the histogram, so leave it null on losing trades.
  const actualPnl = position.aggregatePnl;
  if (actualPnl != null && actualPnl > 0 && mfePnl > 0) {
    updates.exitEfficiency = round(actualPnl / mfePnl, 4);
  }

  // ── Money left on table — dollars missed vs. perfect exit ──────────────
  if (actualPnl != null) {
    updates.moneyLeftOnTable = round(Math.max(0, mfePnl - actualPnl), 2);
  }

  // ── MAE ratio — how much heat was taken to earn the realized P&L ──────
  if (actualPnl != null && actualPnl !== 0) {
    updates.maeRatio = round(Math.abs(maePnl) / Math.abs(actualPnl), 3);
  }

  return updates;
}

function round(value: number, digits: number): number {
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}
