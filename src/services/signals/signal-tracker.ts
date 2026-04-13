/**
 * signal-tracker.ts — Resolve open signals against historical candle data.
 *
 * For each open signal belonging to a wallet:
 *   1. Select candle timeframe based on stop/target distance (tight scalps → 1m, wide swings → 1h)
 *   2. Fetch candles from signal creation through now, batched by (asset, timeframe)
 *   3. Walk candles chronologically, checking high/low against target/stop
 *   4. Expire signals older than 7 days with no resolution
 *   5. Compute outcomePnlPct and outcomeRMultiple, write back to DB
 *   6. Return the list of signals that changed status
 */

import { prisma } from '../../lib/prisma';
import { getCandleCache } from '../candles';

export interface SignalUpdate {
  id: string;
  callerName: string;
  asset: string;
  direction: string;
  previousStatus: string;
  newStatus: string;
  outcomePrice: number | null;
  outcomePnlPct: number | null;
  outcomeRMultiple: number | null;
}

const EXPIRY_DAYS = 7;

function computePnlPct(entryPrice: number, outcomePrice: number, direction: string): number {
  if (direction === 'LONG') {
    return ((outcomePrice - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - outcomePrice) / entryPrice) * 100;
  }
}

function computeRMultiple(
  entryPrice: number,
  outcomePrice: number,
  stopPrice: number | null,
  direction: string,
): number | null {
  if (stopPrice == null) return null;
  const risk = Math.abs(entryPrice - stopPrice);
  if (risk === 0) return null;
  const reward = direction === 'LONG'
    ? outcomePrice - entryPrice
    : entryPrice - outcomePrice;
  return reward / risk;
}

/**
 * Select candle timeframe based on stop (or target) distance from entry.
 * Tight scalp signals get fine-grained candles; wide swing signals use 1h.
 */
function selectTimeframe(
  entryPrice: number,
  stopPrice: number | null,
  targetPrice: number | null,
): string {
  const reference = stopPrice ?? targetPrice;
  if (reference == null) return '1h';
  const distancePct = Math.abs(entryPrice - reference) / entryPrice * 100;
  if (distancePct < 1)  return '1m';
  if (distancePct < 3)  return '5m';
  if (distancePct < 10) return '15m';
  return '1h';
}

export async function checkSignalOutcomes(walletAddress: string): Promise<SignalUpdate[]> {
  const openSignals = await prisma.signal.findMany({
    where: { walletAddress, status: 'open' },
  });

  if (openSignals.length === 0) return [];

  const cache = getCandleCache();
  const now = new Date();
  const updates: SignalUpdate[] = [];

  // Group by (asset, timeframe) so we fetch candles once per bucket
  const byBucket = new Map<string, { timeframe: string; signals: typeof openSignals }>();
  for (const signal of openSignals) {
    const timeframe = selectTimeframe(signal.entryPrice, signal.stopPrice, signal.targetPrice);
    const key = `${signal.asset}:${timeframe}`;
    if (!byBucket.has(key)) byBucket.set(key, { timeframe, signals: [] });
    byBucket.get(key)!.signals.push(signal);
  }

  for (const [, { timeframe, signals }] of byBucket) {
    const asset = signals[0].asset;

    // Fetch candles from the earliest signal creation to now — one request per bucket
    const earliest = signals.reduce(
      (min, s) => (s.createdAt < min ? s.createdAt : min),
      signals[0].createdAt,
    );
    const allCandles = await cache.getCandles(asset, timeframe, earliest, now);

    if (allCandles.length === 0) {
      console.warn(`[signal-tracker] No candle data for ${asset}, falling back to latest price check`);
      continue;
    }

    for (const signal of signals) {
      // Narrow to candles at or after this signal's creation
      const signalCandles = allCandles.filter((c) => c.timestamp >= signal.createdAt);
      if (signalCandles.length === 0) continue;

      const isLong = signal.direction === 'LONG';
      const target = signal.targetPrice;
      const stop = signal.stopPrice;
      let newStatus: string | null = null;
      let outcomePrice: number | null = null;

      for (const candle of signalCandles) {
        const stopHit = stop != null && (isLong ? candle.low <= stop : candle.high >= stop);
        const targetHit = target != null && (isLong ? candle.high >= target : candle.low <= target);

        if (stopHit) {
          // When both trigger on the same candle, assume adverse move first (conservative)
          newStatus = 'hit_stop';
          outcomePrice = stop;
          break;
        }
        if (targetHit) {
          newStatus = 'hit_target';
          outcomePrice = target;
          break;
        }
      }

      if (newStatus == null) {
        const isExpired = signal.createdAt.getTime() < now.getTime() - EXPIRY_DAYS * 86_400_000;
        if (isExpired) {
          newStatus = 'expired';
          outcomePrice = signalCandles[signalCandles.length - 1].close;
        } else {
          continue; // Still open — no DB write
        }
      }

      const resolvedPrice = outcomePrice!;
      const pnlPct = computePnlPct(signal.entryPrice, resolvedPrice, signal.direction);
      const rMultiple = computeRMultiple(signal.entryPrice, resolvedPrice, stop, signal.direction);

      await prisma.signal.update({
        where: { id: signal.id },
        data: {
          status: newStatus,
          outcomePrice: resolvedPrice,
          outcomePnlPct: pnlPct,
          outcomeRMultiple: rMultiple,
          resolvedAt: now,
        },
      });

      updates.push({
        id: signal.id,
        callerName: signal.callerName,
        asset: signal.asset,
        direction: signal.direction,
        previousStatus: 'open',
        newStatus,
        outcomePrice: resolvedPrice,
        outcomePnlPct: pnlPct,
        outcomeRMultiple: rMultiple,
      });
    }
  }

  return updates;
}
