/**
 * grouping-service.ts
 *
 * Orchestrates the hierarchical grouping pipeline:
 *   1. Load fills from DB
 *   2. Level 1: Fills → OrderGroups
 *   3. Classify orders
 *   4. Level 2: OrderGroups → Positions
 *   5. Classify positions
 *   6. Persist everything
 *
 * Level 3 (linking) is manual only — not run automatically.
 *
 * Also provides user correction methods: merge, split, link, unlink,
 * reclassify, moveFill, moveOrder.
 */

import { prisma } from '../../lib/prisma';
import type {
  Fill,
  OrderGroupData,
  PositionData,
  GroupingSummary,
  Classifier,
  ClassificationResult,
  StrategyType,
  LinkedStrategyData,
} from './types';
import { FillToOrderLevel } from './levels/fill-to-order';
import { OrderToPositionLevel } from './levels/order-to-position';
import { PositionLinkingLevel } from './levels/position-linking';
import { createOrderClassifiers } from './classifiers/order-classifier';
import { createPositionClassifiers } from './classifiers/position-classifier';

export class GroupingService {
  private fillToOrder = new FillToOrderLevel();
  private orderToPosition = new OrderToPositionLevel();
  private positionLinking = new PositionLinkingLevel();
  private orderClassifiers = createOrderClassifiers();
  private positionClassifiers = createPositionClassifiers();

  // ─── Run full pipeline ──────────────────────────────────────────────────

  async groupAllFills(walletAddress: string): Promise<GroupingSummary> {
    const dbTrades = await prisma.trade.findMany({
      where: { walletAddress },
      orderBy: { entryTime: 'asc' },
    });

    const fills: Fill[] = dbTrades.map((t) => ({
      id: t.id,
      walletAddress: t.walletAddress,
      asset: t.asset,
      direction: t.direction,
      size: t.size,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      pnlRealized: t.pnlRealized,
      fees: t.fees,
      fundingEarned: t.fundingEarned,
      fundingPaid: t.fundingPaid,
      holdTimeSeconds: t.holdTimeSeconds,
      rawData: t.rawData,
      builderCode: t.builderCode,
      subaccount: t.subaccount,
      tradeType: t.tradeType,
      regimeAtEntry: t.regimeAtEntry,
      sentimentAtEntry: t.sentimentAtEntry,
    }));

    if (fills.length === 0) {
      return {
        totalFills: 0,
        totalOrders: 0,
        totalPositions: 0,
        totalLinkedStrategies: 0,
        positionsByType: {},
        needsReview: 0,
      };
    }

    // Level 1: Fills → OrderGroups
    const orders = this.fillToOrder.group(fills);

    // Classify orders
    for (const order of orders) {
      const classification = classify(order, this.orderClassifiers);
      if (classification) {
        order.tradeType = classification.type;
        order.confidence = Math.min(order.confidence, classification.confidence);
      }
    }

    // Level 2: OrderGroups → Positions
    const positions = this.orderToPosition.group(orders);

    // Classify positions
    for (const position of positions) {
      const classification = classify(position, this.positionClassifiers);
      if (classification) {
        position.tradeType = classification.type;
      }
    }

    // Persist
    await this.persist(fills, orders, positions, walletAddress);

    // Count linked strategies
    const linkedCount = await prisma.linkedStrategy.count({ where: { walletAddress } });

    // Build summary
    const summary: GroupingSummary = {
      totalFills: fills.length,
      totalOrders: orders.length,
      totalPositions: positions.length,
      totalLinkedStrategies: linkedCount,
      positionsByType: {},
      needsReview: positions.filter((p) => p.confidence <= 0.8).length,
    };

    for (const p of positions) {
      const type = p.tradeType ?? 'directional';
      summary.positionsByType[type] = (summary.positionsByType[type] ?? 0) + 1;
    }

    return summary;
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private async persist(
    fills: Fill[],
    orders: OrderGroupData[],
    positions: PositionData[],
    walletAddress: string,
  ): Promise<void> {
    // Clear existing order groups and positions (not linked strategies — those are manual)
    // First unlink fills from order groups
    await prisma.trade.updateMany({
      where: { walletAddress },
      data: { orderGroupId: null },
    });
    // Delete order groups (must delete before positions due to FK)
    await prisma.orderGroup.deleteMany({ where: { walletAddress } });
    // Delete positions that aren't part of linked strategies
    await prisma.position.deleteMany({
      where: { walletAddress, linkedStrategyId: null },
    });
    // Also delete unlinked positions
    await prisma.position.deleteMany({ where: { walletAddress } });

    // Create positions, then order groups, then link fills
    for (const position of positions) {
      const dbPosition = await prisma.position.create({
        data: {
          walletAddress,
          asset: position.asset,
          direction: position.direction,
          status: position.status,
          averageEntryPrice: position.averageEntryPrice,
          averageExitPrice: position.averageExitPrice,
          totalSize: position.totalSize,
          aggregatePnl: position.pnl,
          aggregateFees: position.fees,
          aggregateFunding: position.funding,
          holdTimeSeconds: position.holdTimeSeconds,
          confidence: position.confidence,
          tradeType: position.tradeType,
          regimeAtEntry: position.regimeAtEntry,
          sentimentAtEntry: position.sentimentAtEntry,
          firstEntryTime: position.firstEntryTime,
          lastExitTime: position.lastExitTime,
        },
      });

      for (const order of position.orders) {
        const dbOrder = await prisma.orderGroup.create({
          data: {
            walletAddress,
            asset: order.asset,
            direction: order.direction,
            status: order.status,
            averageEntryPrice: order.averageEntryPrice,
            averageExitPrice: order.averageExitPrice,
            totalSize: order.totalSize,
            aggregatePnl: order.pnl,
            aggregateFees: order.fees,
            aggregateFunding: order.funding,
            confidence: order.confidence,
            ruleSource: order.ruleSource,
            tradeType: order.tradeType,
            firstEntryTime: order.firstEntryTime,
            lastExitTime: order.lastExitTime,
            positionId: dbPosition.id,
          },
        });

        // Link fills to this order group
        const fillIds = order.fills.map((f) => f.id);
        await prisma.trade.updateMany({
          where: { id: { in: fillIds } },
          data: { orderGroupId: dbOrder.id },
        });
      }
    }
  }

  // ─── User corrections ──────────────────────────────────────────────────

  async mergePositions(positionIds: string[]) {
    if (positionIds.length < 2) throw new Error('Need at least 2 positions to merge');

    const positions = await prisma.position.findMany({
      where: { id: { in: positionIds } },
      include: { orderGroups: true },
    });
    if (positions.length !== positionIds.length) throw new Error('One or more positions not found');

    const target = positions[0];
    const otherIds = positionIds.slice(1);

    // Move all order groups to the target position
    await prisma.orderGroup.updateMany({
      where: { positionId: { in: otherIds } },
      data: { positionId: target.id },
    });

    // Delete the other positions
    await prisma.position.deleteMany({ where: { id: { in: otherIds } } });

    // Recompute aggregates
    await this.recomputePosition(target.id);

    return prisma.position.findUnique({ where: { id: target.id } });
  }

  async splitPosition(positionId: string, splitTime: Date) {
    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: { orderGroups: { orderBy: { firstEntryTime: 'asc' } } },
    });
    if (!position) throw new Error('Position not found');

    const before = position.orderGroups.filter((og) => {
      const time = og.firstEntryTime ?? og.lastExitTime;
      return time != null && time.getTime() <= splitTime.getTime();
    });
    const after = position.orderGroups.filter((og) => {
      const time = og.firstEntryTime ?? og.lastExitTime;
      return time == null || time.getTime() > splitTime.getTime();
    });

    if (before.length === 0 || after.length === 0) {
      throw new Error('Split point must divide orders into two non-empty groups');
    }

    const newPosition = await prisma.position.create({
      data: {
        walletAddress: position.walletAddress,
        asset: position.asset,
        direction: position.direction,
        status: position.status,
        tradeType: position.tradeType,
        confidence: position.confidence,
      },
    });

    await prisma.orderGroup.updateMany({
      where: { id: { in: after.map((og) => og.id) } },
      data: { positionId: newPosition.id },
    });

    await Promise.all([
      this.recomputePosition(position.id),
      this.recomputePosition(newPosition.id),
    ]);

    return Promise.all([
      prisma.position.findUnique({ where: { id: position.id } }),
      prisma.position.findUnique({ where: { id: newPosition.id } }),
    ]);
  }

  async linkPositions(positionIds: string[], strategyType: StrategyType) {
    if (positionIds.length < 2) throw new Error('Need at least 2 positions to link');

    const positions = await prisma.position.findMany({
      where: { id: { in: positionIds } },
    });
    if (positions.length !== positionIds.length) throw new Error('One or more positions not found');

    // Validate using the linking level
    const positionData: PositionData[] = positions.map((p) => ({
      id: p.id,
      asset: p.asset,
      direction: p.direction as 'long' | 'short',
      orders: [],
      totalSize: p.totalSize ?? 0,
      averageEntryPrice: p.averageEntryPrice ?? 0,
      averageExitPrice: p.averageExitPrice,
      pnl: p.aggregatePnl ?? 0,
      fees: p.aggregateFees ?? 0,
      funding: p.aggregateFunding ?? 0,
      status: p.status as 'open' | 'closed',
      firstEntryTime: p.firstEntryTime,
      lastExitTime: p.lastExitTime,
      holdTimeSeconds: p.holdTimeSeconds,
      tradeType: p.tradeType,
      confidence: p.confidence ?? 0,
      regimeAtEntry: p.regimeAtEntry,
      sentimentAtEntry: p.sentimentAtEntry,
      linkedStrategyId: null,
    }));

    // Will throw if validation fails
    const strategyData = this.positionLinking.link(positionData, strategyType);

    const ls = await prisma.linkedStrategy.create({
      data: {
        walletAddress: positions[0].walletAddress,
        strategyType,
        combinedPnl: strategyData.combinedPnl,
        combinedFees: strategyData.combinedFees,
        combinedFunding: strategyData.combinedFunding,
        netDelta: strategyData.netDelta,
        spreadPnl: strategyData.spreadPnl,
        status: strategyData.status,
        confidence: strategyData.confidence,
        tradeType: strategyType,
        firstEntryTime: strategyData.firstEntryTime,
        lastExitTime: strategyData.lastExitTime,
      },
    });

    await prisma.position.updateMany({
      where: { id: { in: positionIds } },
      data: { linkedStrategyId: ls.id },
    });

    return prisma.linkedStrategy.findUnique({
      where: { id: ls.id },
      include: { positions: true },
    });
  }

  async unlinkStrategy(linkedStrategyId: string) {
    await prisma.position.updateMany({
      where: { linkedStrategyId },
      data: { linkedStrategyId: null },
    });
    await prisma.linkedStrategy.delete({ where: { id: linkedStrategyId } });
  }

  async reclassifyPosition(positionId: string, newType: string) {
    return prisma.position.update({
      where: { id: positionId },
      data: { tradeType: newType },
    });
  }

  async moveFillToOrder(fillId: string, targetOrderGroupId: string) {
    const fill = await prisma.trade.findUnique({ where: { id: fillId } });
    if (!fill) throw new Error('Fill not found');

    const oldOrderGroupId = fill.orderGroupId;

    await prisma.trade.update({
      where: { id: fillId },
      data: { orderGroupId: targetOrderGroupId },
    });

    await this.recomputeOrderGroup(targetOrderGroupId);
    if (oldOrderGroupId) {
      const remaining = await prisma.trade.count({ where: { orderGroupId: oldOrderGroupId } });
      if (remaining === 0) {
        await prisma.orderGroup.delete({ where: { id: oldOrderGroupId } });
      } else {
        await this.recomputeOrderGroup(oldOrderGroupId);
      }
    }
  }

  async moveOrderToPosition(orderGroupId: string, targetPositionId: string) {
    const og = await prisma.orderGroup.findUnique({ where: { id: orderGroupId } });
    if (!og) throw new Error('Order group not found');

    const oldPositionId = og.positionId;

    await prisma.orderGroup.update({
      where: { id: orderGroupId },
      data: { positionId: targetPositionId },
    });

    await this.recomputePosition(targetPositionId);
    if (oldPositionId) {
      const remaining = await prisma.orderGroup.count({ where: { positionId: oldPositionId } });
      if (remaining === 0) {
        await prisma.position.delete({ where: { id: oldPositionId } });
      } else {
        await this.recomputePosition(oldPositionId);
      }
    }
  }

  // ─── Recompute aggregates ───────────────────────────────────────────────

  private async recomputeOrderGroup(orderGroupId: string) {
    const fills = await prisma.trade.findMany({ where: { orderGroupId } });
    if (fills.length === 0) return;

    const totalSize = fills.reduce((s, f) => s + f.size, 0);
    const totalPnl = fills.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
    const totalFees = fills.reduce((s, f) => s + (f.fees ?? 0), 0);
    const totalFunding = fills.reduce(
      (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0), 0,
    );

    const entryFills = fills.filter((f) => f.entryPrice > 0);
    const exitFills = fills.filter((f) => f.exitPrice != null && f.exitPrice > 0);
    const avgEntry = weightedAvg(entryFills.map((f) => ({ price: f.entryPrice, size: f.size })));
    const avgExit = exitFills.length > 0
      ? weightedAvg(exitFills.map((f) => ({ price: f.exitPrice!, size: f.size })))
      : null;

    const allTimes = fills
      .flatMap((f) => [f.entryTime, f.exitTime])
      .filter((t): t is Date => t != null)
      .map((t) => t.getTime());

    await prisma.orderGroup.update({
      where: { id: orderGroupId },
      data: {
        totalSize,
        aggregatePnl: totalPnl,
        aggregateFees: totalFees,
        aggregateFunding: totalFunding,
        averageEntryPrice: avgEntry,
        averageExitPrice: avgExit,
        firstEntryTime: allTimes.length > 0 ? new Date(Math.min(...allTimes)) : null,
        lastExitTime: allTimes.length > 0 ? new Date(Math.max(...allTimes)) : null,
        status: fills.some((f) => f.exitTime == null) ? 'open' : 'closed',
      },
    });
  }

  private async recomputePosition(positionId: string) {
    const orderGroups = await prisma.orderGroup.findMany({
      where: { positionId },
      include: { trades: true },
    });

    const allFills = orderGroups.flatMap((og) => og.trades);
    if (allFills.length === 0) return;

    const totalSize = allFills.reduce((s, f) => s + f.size, 0);
    const totalPnl = allFills.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
    const totalFees = allFills.reduce((s, f) => s + (f.fees ?? 0), 0);
    const totalFunding = allFills.reduce(
      (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0), 0,
    );

    const entryFills = allFills.filter((f) => f.entryPrice > 0);
    const exitFills = allFills.filter((f) => f.exitPrice != null && f.exitPrice > 0);
    const avgEntry = weightedAvg(entryFills.map((f) => ({ price: f.entryPrice, size: f.size })));
    const avgExit = exitFills.length > 0
      ? weightedAvg(exitFills.map((f) => ({ price: f.exitPrice!, size: f.size })))
      : null;

    const allTimes = allFills
      .flatMap((f) => [f.entryTime, f.exitTime])
      .filter((t): t is Date => t != null)
      .map((t) => t.getTime());

    const firstEntryTime = allTimes.length > 0 ? new Date(Math.min(...allTimes)) : null;
    const lastExitTime = allTimes.length > 0 ? new Date(Math.max(...allTimes)) : null;
    const holdTimeSeconds = firstEntryTime && lastExitTime
      ? Math.round((lastExitTime.getTime() - firstEntryTime.getTime()) / 1000)
      : null;

    const regimeAtEntry = allFills.sort(
      (a, b) => (a.entryTime?.getTime() ?? 0) - (b.entryTime?.getTime() ?? 0),
    )[0]?.regimeAtEntry ?? null;

    await prisma.position.update({
      where: { id: positionId },
      data: {
        totalSize,
        aggregatePnl: totalPnl,
        aggregateFees: totalFees,
        aggregateFunding: totalFunding,
        averageEntryPrice: avgEntry,
        averageExitPrice: avgExit,
        firstEntryTime,
        lastExitTime,
        holdTimeSeconds,
        regimeAtEntry,
        status: allFills.some((f) => f.exitTime == null) ? 'open' : 'closed',
      },
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function classify<T>(item: T, classifiers: Classifier<T>[]): ClassificationResult | null {
  let best: ClassificationResult | null = null;
  for (const c of classifiers) {
    const result = c.classify(item);
    if (result && (!best || result.confidence > best.confidence)) {
      best = result;
    }
  }
  return best;
}

function weightedAvg(items: { price: number; size: number }[]): number {
  const totalSize = items.reduce((s, i) => s + i.size, 0);
  if (totalSize === 0) return 0;
  return items.reduce((s, i) => s + i.price * i.size, 0) / totalSize;
}
