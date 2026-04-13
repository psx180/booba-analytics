/**
 * signal-tracker.ts — Resolve open signals against current price data.
 *
 * For each open signal belonging to a wallet:
 *   1. Pull the latest 1h candle from the cache
 *   2. Check whether targetPrice or stopPrice has been hit
 *   3. Expire signals older than 7 days
 *   4. Compute outcomePnlPct and outcomeRMultiple, write back to DB
 *   5. Return the list of signals that changed status
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

export async function checkSignalOutcomes(walletAddress: string): Promise<SignalUpdate[]> {
  const openSignals = await prisma.signal.findMany({
    where: { walletAddress, status: 'open' },
  });

  if (openSignals.length === 0) return [];

  const cache = getCandleCache();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const sevenDaysAgo = new Date(now.getTime() - EXPIRY_DAYS * 86_400_000);
  const updates: SignalUpdate[] = [];

  for (const signal of openSignals) {
    // Fetch latest close price
    const candles = await cache.getCandles(signal.asset, '1h', oneHourAgo, now);
    if (candles.length === 0) continue;
    const latestClose = candles[candles.length - 1].close;

    let newStatus: string | null = null;
    let outcomePrice: number | null = null;

    const isLong = signal.direction === 'LONG';
    const target = signal.targetPrice;
    const stop = signal.stopPrice;

    // Check target hit
    if (target != null) {
      const targetHit = isLong ? latestClose >= target : latestClose <= target;
      if (targetHit) {
        newStatus = 'hit_target';
        outcomePrice = target;
      }
    }

    // Check stop hit (stop takes priority if both hit simultaneously, which is unusual but possible)
    if (stop != null) {
      const stopHit = isLong ? latestClose <= stop : latestClose >= stop;
      if (stopHit) {
        newStatus = 'hit_stop';
        outcomePrice = stop;
      }
    }

    // Expire if older than 7 days with no resolution
    if (newStatus == null && signal.createdAt < sevenDaysAgo) {
      newStatus = 'expired';
      outcomePrice = latestClose;
    }

    if (newStatus == null) {
      // Still open — no DB write, just continue
      continue;
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

  return updates;
}
