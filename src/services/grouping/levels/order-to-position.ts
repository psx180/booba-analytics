/**
 * Level 2 — Order to Position
 *
 * Groups OrderGroups into Positions by tracking net exposure per
 * asset+subaccount over time:
 *
 *   - Exposure goes 0 → non-zero: start a new position
 *   - Exposure returns to 0: close the position
 *   - Gap detection: if exposure hits 0 and the next order on the same
 *     asset arrives >30s later, that's a new position
 *   - Still-open: exposure never returns to 0 → open position
 *
 * Builder code override: orders sharing a builder code on the same asset
 * within a continuous session (gap <1h) form one position regardless of
 * net-zero crossings. Market makers constantly oscillate around zero.
 *
 * This is the primary analytical unit — P&L, win rate, regime tagging,
 * MFE/MAE, hold time all operate at this level.
 *
 * Answers: "What was the directional bet?"
 */

import type { GroupingLevel, OrderGroupData, PositionData } from '../types';
import { parseRawData } from '../types';

export interface OrderToPositionConfig {
  /** Gap after net-zero before starting a new position (ms). Default: 30s. */
  reopenGapMs: number;
  /** Max gap between consecutive builder-code orders in a session (ms). Default: 1h. */
  builderSessionGapMs: number;
}

const DEFAULT_CONFIG: OrderToPositionConfig = {
  reopenGapMs: 30_000,
  builderSessionGapMs: 60 * 60 * 1000,
};

export class OrderToPositionLevel implements GroupingLevel<OrderGroupData, PositionData> {
  readonly name = 'order-to-position';
  private config: OrderToPositionConfig;

  constructor(config: Partial<OrderToPositionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  group(orders: OrderGroupData[]): PositionData[] {
    if (orders.length === 0) return [];

    // First, extract builder-code sessions — these override lifecycle logic
    const { builderOrders, regularOrders } = this.partitionByBuilderCode(orders);

    const positions: PositionData[] = [];

    // Process builder-code sessions first
    for (const sessionOrders of builderOrders) {
      // Determine if the session ended at net-zero
      let netExp = 0;
      for (const order of sessionOrders) {
        netExp += this.computeExposureDelta(order);
      }
      const status = Math.abs(netExp) < 1e-10 ? 'closed' : 'open';
      positions.push(this.buildPosition(sessionOrders, 0.9, status as 'open' | 'closed'));
    }

    // Process regular orders by asset+subaccount lifecycle
    const byAsset = new Map<string, OrderGroupData[]>();
    for (const order of regularOrders) {
      const sub = this.getSubaccount(order);
      const key = `${order.asset}:${sub}`;
      if (!byAsset.has(key)) byAsset.set(key, []);
      byAsset.get(key)!.push(order);
    }

    for (const [, assetOrders] of byAsset) {
      const assetPositions = this.groupByLifecycle(assetOrders);
      positions.push(...assetPositions);
    }

    return positions;
  }

  private partitionByBuilderCode(orders: OrderGroupData[]): {
    builderOrders: OrderGroupData[][];
    regularOrders: OrderGroupData[];
  } {
    const withBuilder: OrderGroupData[] = [];
    const regularOrders: OrderGroupData[] = [];

    for (const order of orders) {
      const hasBuilder = order.fills.some((f) => f.builderCode);
      if (hasBuilder) {
        withBuilder.push(order);
      } else {
        regularOrders.push(order);
      }
    }

    if (withBuilder.length === 0) {
      return { builderOrders: [], regularOrders };
    }

    // Group builder orders by builderCode + asset, then split by session gap
    const buckets = new Map<string, OrderGroupData[]>();
    for (const order of withBuilder) {
      const code = order.fills.find((f) => f.builderCode)?.builderCode ?? 'unknown';
      const key = `${code}:${order.asset}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(order);
    }

    const builderSessions: OrderGroupData[][] = [];
    for (const [, bucketOrders] of buckets) {
      const sorted = [...bucketOrders].sort(
        (a, b) => this.orderTime(a) - this.orderTime(b),
      );

      let session: OrderGroupData[] = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        const prevTime = this.orderTime(session[session.length - 1]);
        const currTime = this.orderTime(sorted[i]);
        if (currTime - prevTime > this.config.builderSessionGapMs) {
          builderSessions.push(session);
          session = [];
        }
        session.push(sorted[i]);
      }
      if (session.length > 0) builderSessions.push(session);
    }

    return { builderOrders: builderSessions, regularOrders };
  }

  private groupByLifecycle(orders: OrderGroupData[]): PositionData[] {
    const sorted = [...orders].sort(
      (a, b) => this.orderTime(a) - this.orderTime(b),
    );

    const positions: PositionData[] = [];
    let currentOrders: OrderGroupData[] = [];
    let netExposure = 0;
    let lastZeroTime: number | null = null;

    for (const order of sorted) {
      const orderTime = this.orderTime(order);

      // Gap detection: if we were at zero and enough time passed, start new position
      if (netExposure === 0 && currentOrders.length > 0 && lastZeroTime !== null) {
        const gap = orderTime - lastZeroTime;
        if (gap > this.config.reopenGapMs) {
          // Already emitted at zero-crossing, but if there are leftover orders, flush
          currentOrders = [];
          lastZeroTime = null;
        }
      }

      // If at zero with no current orders, just start fresh
      if (netExposure === 0 && currentOrders.length === 0) {
        lastZeroTime = null;
      }

      currentOrders.push(order);

      // Update net exposure based on order fills
      const exposureDelta = this.computeExposureDelta(order);
      netExposure += exposureDelta;

      // Snap to zero for floating point dust
      if (Math.abs(netExposure) < 1e-10) {
        netExposure = 0;
        lastZeroTime = orderTime;

        // Position closed — emit as closed
        positions.push(this.buildPosition(currentOrders, 0.85, 'closed'));
        currentOrders = [];
      }
    }

    // Flush any remaining orders as an open position
    if (currentOrders.length > 0) {
      positions.push(this.buildPosition(currentOrders, 0.85, 'open'));
    }

    return positions;
  }

  private computeExposureDelta(order: OrderGroupData): number {
    let delta = 0;
    for (const fill of order.fills) {
      const raw = parseRawData(fill);
      const side = raw.side ?? '';
      const size = fill.size;

      if (side.startsWith('open_')) {
        delta += size;
      } else if (side.startsWith('close_')) {
        delta -= size;
      } else {
        // If no side info, infer from entry/exit
        if (fill.exitPrice != null) {
          delta -= size;
        } else {
          delta += size;
        }
      }
    }
    return delta;
  }

  private buildPosition(orders: OrderGroupData[], confidence: number, status: 'open' | 'closed'): PositionData {
    const allFills = orders.flatMap((o) => o.fills);
    const sorted = [...orders].sort(
      (a, b) => this.orderTime(a) - this.orderTime(b),
    );

    const asset = sorted[0].asset;
    const directions = sorted.map((o) => o.direction);
    const longCount = directions.filter((d) => d === 'long').length;
    const direction = (longCount >= directions.length / 2 ? 'long' : 'short') as 'long' | 'short';

    const totalSize = allFills.reduce((s, f) => s + f.size, 0);
    const totalPnl = allFills.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
    const totalFees = allFills.reduce((s, f) => s + (f.fees ?? 0), 0);
    const totalFunding = allFills.reduce(
      (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0),
      0,
    );

    const entryFills = allFills.filter((f) => f.entryPrice > 0);
    const exitFills = allFills.filter((f) => f.exitPrice != null && f.exitPrice > 0);
    const avgEntry = weightedAvg(entryFills.map((f) => ({ price: f.entryPrice, size: f.size })));
    const avgExit = exitFills.length > 0
      ? weightedAvg(exitFills.map((f) => ({ price: f.exitPrice!, size: f.size })))
      : null;

    const allTimes = allFills
      .flatMap((f) => [f.entryTime, f.exitTime])
      .filter((t): t is Date => t != null);
    const firstEntryTime = allTimes.length > 0
      ? new Date(Math.min(...allTimes.map((t) => t.getTime())))
      : null;
    const lastExitTime = allTimes.length > 0
      ? new Date(Math.max(...allTimes.map((t) => t.getTime())))
      : null;

    const holdTimeSeconds =
      firstEntryTime && lastExitTime
        ? Math.round((lastExitTime.getTime() - firstEntryTime.getTime()) / 1000)
        : null;

    const regimeAtEntry = sorted[0].fills[0]?.regimeAtEntry ?? null;
    const sentimentAtEntry = sorted[0].fills[0]?.sentimentAtEntry ?? null;

    // Take the first non-null builder code we see, ordered by entry time.
    // Most positions are uniform (every fill carries the same builder, or
    // none). Mixed cases are vanishingly rare; first-fill semantics match
    // how regimeAtEntry is captured.
    const firstBuilder = allFills
      .slice()
      .sort((a, b) => (a.entryTime?.getTime() ?? 0) - (b.entryTime?.getTime() ?? 0))
      .find((f) => f.builderCode);
    const builderCode = firstBuilder?.builderCode ?? null;

    return {
      id: `pos_${sorted[0].id}`,
      asset,
      direction,
      orders: sorted,
      totalSize,
      averageEntryPrice: avgEntry,
      averageExitPrice: avgExit,
      pnl: totalPnl,
      fees: totalFees,
      funding: totalFunding,
      status,
      firstEntryTime,
      lastExitTime,
      holdTimeSeconds,
      tradeType: null, // set by classifier
      confidence,
      regimeAtEntry,
      sentimentAtEntry,
      linkedStrategyId: null,
      builderCode,
    };
  }

  private orderTime(order: OrderGroupData): number {
    return (order.firstEntryTime ?? order.lastExitTime ?? new Date(0)).getTime();
  }

  private getSubaccount(order: OrderGroupData): string {
    return order.fills[0]?.subaccount ?? 'default';
  }
}

function weightedAvg(items: { price: number; size: number }[]): number {
  const totalSize = items.reduce((s, i) => s + i.size, 0);
  if (totalSize === 0) return 0;
  return items.reduce((s, i) => s + i.price * i.size, 0) / totalSize;
}
