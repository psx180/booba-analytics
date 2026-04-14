/**
 * signal-tracker.ts — Resolve open signals against historical candle data.
 *
 * For each open signal belonging to a wallet:
 *   1. Select candle timeframe based on stop/target distance (tight scalps → 1m, wide swings → 1h)
 *   2. Fetch candles from signal creation through now, batched by (asset, timeframe)
 *   3. Walk candles chronologically, checking high/low against each target and stop
 *      - Stop is checked first per candle (conservative: adverse move wins on same candle)
 *      - Each unhit target is checked; when all are hit the signal is fully resolved
 *      - partial_target: some TPs hit then stop fired
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
 * Select candle timeframe based on stop (or first target) distance from entry.
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
      const stop = signal.stopPrice;

      // Parse target list — prefer targetPrices JSON array, fall back to single targetPrice
      const targets: number[] = signal.targetPrices
        ? JSON.parse(signal.targetPrices as string)
        : signal.targetPrice != null ? [signal.targetPrice] : [];

      // Track which targets have been hit
      const hitFlags = new Array<boolean>(targets.length).fill(false);

      let newStatus: string | null = null;
      let outcomePrice: number | null = null;
      let stopHitDuringWalk = false;

      for (const candle of signalCandles) {
        // Stop is checked first — if stop fires, no same-candle TP credit (conservative)
        const stopHit = stop != null && (isLong ? candle.low <= stop : candle.high >= stop);
        if (stopHit) {
          stopHitDuringWalk = true;
          break;
        }

        // Mark any newly-hit targets
        for (let i = 0; i < targets.length; i++) {
          if (!hitFlags[i]) {
            const tpHit = isLong ? candle.high >= targets[i] : candle.low <= targets[i];
            if (tpHit) hitFlags[i] = true;
          }
        }

        // All targets hit — fully resolved
        if (targets.length > 0 && hitFlags.every(Boolean)) {
          newStatus = 'hit_target';
          outcomePrice = targets[targets.length - 1];
          break;
        }
      }

      // Determine outcome after the walk
      if (newStatus == null) {
        const someHit = hitFlags.some(Boolean);

        if (stopHitDuringWalk) {
          if (!someHit) {
            // Stop hit before any TP
            newStatus = 'hit_stop';
            outcomePrice = stop!;
          } else {
            // Some TPs hit, then stopped out
            newStatus = 'partial_target';
            // outcomePrice = equal-weight average across all TP slots
            // hit slots use TP price, missed slots use stop price
            const n = targets.length;
            const priceSum = targets.reduce(
              (sum, tp, i) => sum + (hitFlags[i] ? tp : stop!),
              0,
            );
            outcomePrice = priceSum / n;
          }
        }
      }

      // Expiry check
      if (newStatus == null) {
        const isExpired = signal.createdAt.getTime() < now.getTime() - EXPIRY_DAYS * 86_400_000;
        if (isExpired) {
          newStatus = 'expired';
          outcomePrice = signalCandles[signalCandles.length - 1].close;
        } else {
          continue; // Still open — no DB write
        }
      }

      // Compute P&L
      let pnlPct: number;
      let rMultiple: number | null;

      if (newStatus === 'partial_target' && targets.length > 0) {
        // Weighted return: each TP slot gets equal weight (1/n)
        const n = targets.length;
        pnlPct = targets.reduce((sum, tp, i) => {
          const slotPrice = hitFlags[i] ? tp : stop!;
          return sum + computePnlPct(signal.entryPrice, slotPrice, signal.direction) / n;
        }, 0);

        // R-multiple based on highest hit TP
        const hitPrices = targets.filter((_, i) => hitFlags[i]);
        const highestHitTP = signal.direction === 'LONG'
          ? Math.max(...hitPrices)
          : Math.min(...hitPrices);
        rMultiple = computeRMultiple(signal.entryPrice, highestHitTP, stop, signal.direction);
      } else {
        pnlPct = computePnlPct(signal.entryPrice, outcomePrice!, signal.direction);
        rMultiple = computeRMultiple(signal.entryPrice, outcomePrice!, stop, signal.direction);
      }

      // Build targetPricesHit boolean array for resolved signals with multiple TPs
      const targetPricesHit =
        targets.length > 0 && newStatus !== 'expired'
          ? JSON.stringify(
              newStatus === 'hit_target'
                ? targets.map(() => true)
                : newStatus === 'hit_stop'
                  ? targets.map(() => false)
                  : hitFlags,
            )
          : null;

      await prisma.signal.update({
        where: { id: signal.id },
        data: {
          status: newStatus,
          outcomePrice: outcomePrice!,
          outcomePnlPct: pnlPct,
          outcomeRMultiple: rMultiple,
          targetPricesHit,
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
        outcomePrice: outcomePrice!,
        outcomePnlPct: pnlPct,
        outcomeRMultiple: rMultiple,
      });
    }
  }

  return updates;
}
