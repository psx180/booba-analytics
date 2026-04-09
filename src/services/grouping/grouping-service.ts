/**
 * grouping-service.ts
 *
 * Orchestrates the grouping pipeline:
 *   1. Load fills from DB
 *   2. Run rules in priority order (Chain of Responsibility)
 *   3. Classify each proposed group
 *   4. Compute aggregate stats
 *   5. Persist groups + update fill→group links
 *
 * Also provides user correction methods: merge, split, link, reclassify, moveFill.
 */

import { prisma } from '../../lib/prisma';
import type {
  Fill,
  GroupingRule,
  GroupClassifier,
  ProposedGroup,
  GroupingSummary,
  TradeType,
  ClassificationResult,
} from './types';
import { createDefaultRules } from './rules';
import { createDefaultClassifiers } from './classifiers';

export class GroupingService {
  private rules: GroupingRule[];
  private classifiers: GroupClassifier[];

  constructor(
    rules?: GroupingRule[],
    classifiers?: GroupClassifier[],
  ) {
    this.rules = rules ?? createDefaultRules();
    this.classifiers = classifiers ?? createDefaultClassifiers();
  }

  // ─── Run full pipeline ──────────────────────────────────────────────────

  async groupAllFills(walletAddress: string): Promise<GroupingSummary> {
    // Load all fills for this wallet
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
    }));

    return this.runPipeline(fills, walletAddress);
  }

  async groupNewFills(fills: Fill[], walletAddress: string): Promise<GroupingSummary> {
    return this.runPipeline(fills, walletAddress);
  }

  private async runPipeline(fills: Fill[], walletAddress: string): Promise<GroupingSummary> {
    if (fills.length === 0) {
      return {
        totalFills: 0,
        totalGroups: 0,
        autoGroupedHighConfidence: 0,
        needsReview: 0,
        byType: {},
        byRule: {},
      };
    }

    // Step 1: Run rules in order
    let remainingFills = fills;
    const allGroups: ProposedGroup[] = [];

    for (const rule of this.rules) {
      const result = rule.apply(remainingFills, allGroups);
      allGroups.push(...result.newGroups);
      remainingFills = result.remainingFills;
    }

    // Any fills still remaining get individual groups
    for (const fill of remainingFills) {
      allGroups.push({
        fills: [fill],
        confidence: 0.3,
        ruleSource: 'ungrouped',
      });
    }

    // Step 2: Classify each group
    for (const group of allGroups) {
      const classification = this.classify(group);
      group.classifiedType = classification.type;
      group.classifiedConfidence = classification.confidence;
    }

    // Step 3: Persist — clear old groups for this wallet, write new ones
    await this.persistGroups(allGroups, walletAddress);

    // Step 4: Build summary
    const summary: GroupingSummary = {
      totalFills: fills.length,
      totalGroups: allGroups.length,
      autoGroupedHighConfidence: allGroups.filter((g) => g.confidence > 0.8).length,
      needsReview: allGroups.filter((g) => g.confidence <= 0.8).length,
      byType: {},
      byRule: {},
    };

    for (const g of allGroups) {
      const type = g.classifiedType ?? 'directional';
      summary.byType[type] = (summary.byType[type] ?? 0) + 1;
      summary.byRule[g.ruleSource] = (summary.byRule[g.ruleSource] ?? 0) + 1;
    }

    return summary;
  }

  private classify(group: ProposedGroup): ClassificationResult {
    let best: ClassificationResult = { type: 'directional', confidence: 0 };

    for (const classifier of this.classifiers) {
      const result = classifier.classify(group);
      if (result && result.confidence > best.confidence) {
        best = result;
      }
    }

    return best;
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private async persistGroups(groups: ProposedGroup[], walletAddress: string): Promise<void> {
    // Delete existing groups for this wallet and unlink fills
    await prisma.trade.updateMany({
      where: { walletAddress },
      data: { groupId: null },
    });
    await prisma.tradeGroup.deleteMany({
      where: { walletAddress },
    });

    // Create new groups
    for (const group of groups) {
      const agg = this.computeAggregates(group);
      const tradeType = group.classifiedType ?? group.suggestedType ?? 'directional';
      const status = this.inferStatus(group);

      const created = await prisma.tradeGroup.create({
        data: {
          walletAddress,
          asset: agg.asset,
          direction: agg.direction,
          status,
          tradeType,
          totalSize: agg.totalSize,
          averageEntryPrice: agg.avgEntryPrice,
          averageExitPrice: agg.avgExitPrice,
          aggregatePnl: agg.totalPnl,
          aggregateFees: agg.totalFees,
          aggregateFunding: agg.totalFunding,
          firstEntryTime: agg.firstEntryTime,
          lastExitTime: agg.lastExitTime,
          holdTimeSeconds: agg.holdTimeSeconds,
          confidence: group.confidence,
          ruleSource: group.ruleSource,
        },
      });

      // Link fills to this group
      const fillIds = group.fills.map((f) => f.id);
      await prisma.trade.updateMany({
        where: { id: { in: fillIds } },
        data: { groupId: created.id },
      });
    }
  }

  private computeAggregates(group: ProposedGroup) {
    const fills = group.fills;
    const asset = fills[0].asset;

    // Direction: majority direction of open fills, or first fill
    const directions = fills.map((f) => f.direction);
    const longCount = directions.filter((d) => d === 'long').length;
    const direction = longCount >= directions.length / 2 ? 'long' : 'short';

    // Size: sum of entry sizes (non-close fills)
    const totalSize = fills.reduce((s, f) => s + f.size, 0);

    // Weighted average prices
    const entryFills = fills.filter((f) => f.entryTime != null && f.entryPrice > 0);
    const exitFills = fills.filter((f) => f.exitPrice != null && f.exitPrice > 0);

    const avgEntryPrice = weightedAvg(
      entryFills.map((f) => ({ price: f.entryPrice, size: f.size })),
    );
    const avgExitPrice = exitFills.length > 0
      ? weightedAvg(exitFills.map((f) => ({ price: f.exitPrice!, size: f.size })))
      : null;

    // PnL, fees, funding
    const totalPnl = fills.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
    const totalFees = fills.reduce((s, f) => s + (f.fees ?? 0), 0);
    const totalFunding = fills.reduce(
      (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0),
      0,
    );

    // Times
    const allTimes = fills
      .flatMap((f) => [f.entryTime, f.exitTime])
      .filter((t): t is Date => t != null)
      .map((t) => t.getTime());

    const firstEntryTime = allTimes.length > 0 ? new Date(Math.min(...allTimes)) : null;
    const lastExitTime = allTimes.length > 0 ? new Date(Math.max(...allTimes)) : null;

    const holdTimeSeconds =
      firstEntryTime && lastExitTime
        ? Math.round((lastExitTime.getTime() - firstEntryTime.getTime()) / 1000)
        : null;

    return {
      asset,
      direction,
      totalSize,
      avgEntryPrice,
      avgExitPrice,
      totalPnl,
      totalFees,
      totalFunding,
      firstEntryTime,
      lastExitTime,
      holdTimeSeconds,
    };
  }

  private inferStatus(group: ProposedGroup): string {
    // If any fill has no exit, the group is still open
    const hasOpenFill = group.fills.some((f) => f.exitTime == null && f.exitPrice == null);
    return hasOpenFill ? 'open' : 'closed';
  }

  // ─── User corrections ──────────────────────────────────────────────────

  async mergeGroups(groupIds: string[]) {
    if (groupIds.length < 2) throw new Error('Need at least 2 groups to merge');

    const groups = await prisma.tradeGroup.findMany({
      where: { id: { in: groupIds } },
      include: { trades: true },
    });

    if (groups.length !== groupIds.length) {
      throw new Error('One or more groups not found');
    }

    // Keep the first group, merge others into it
    const target = groups[0];
    const otherIds = groupIds.slice(1);

    // Move all fills to the target group
    await prisma.trade.updateMany({
      where: { groupId: { in: otherIds } },
      data: { groupId: target.id },
    });

    // Delete the other groups
    await prisma.tradeGroup.deleteMany({
      where: { id: { in: otherIds } },
    });

    // Recompute aggregates on the merged group
    await this.recomputeGroupAggregates(target.id);

    return prisma.tradeGroup.findUnique({ where: { id: target.id } });
  }

  async splitGroup(groupId: string, splitTime: Date) {
    const group = await prisma.tradeGroup.findUnique({
      where: { id: groupId },
      include: { trades: { orderBy: { entryTime: 'asc' } } },
    });

    if (!group) throw new Error('Group not found');

    const beforeFills = group.trades.filter((t) => {
      const time = t.entryTime ?? t.exitTime;
      return time != null && time.getTime() <= splitTime.getTime();
    });
    const afterFills = group.trades.filter((t) => {
      const time = t.entryTime ?? t.exitTime;
      return time == null || time.getTime() > splitTime.getTime();
    });

    if (beforeFills.length === 0 || afterFills.length === 0) {
      throw new Error('Split point must divide fills into two non-empty groups');
    }

    // Create a new group for the "after" fills
    const newGroup = await prisma.tradeGroup.create({
      data: {
        walletAddress: group.walletAddress,
        asset: group.asset,
        direction: group.direction,
        status: group.status,
        tradeType: group.tradeType,
        confidence: group.confidence,
        ruleSource: 'user-split',
      },
    });

    // Move after fills to the new group
    await prisma.trade.updateMany({
      where: { id: { in: afterFills.map((f) => f.id) } },
      data: { groupId: newGroup.id },
    });

    // Recompute both groups
    await Promise.all([
      this.recomputeGroupAggregates(group.id),
      this.recomputeGroupAggregates(newGroup.id),
    ]);

    return Promise.all([
      prisma.tradeGroup.findUnique({ where: { id: group.id } }),
      prisma.tradeGroup.findUnique({ where: { id: newGroup.id } }),
    ]);
  }

  async linkGroups(groupIds: string[], linkType: 'delta_neutral' | 'pairs_trade') {
    if (groupIds.length < 2) throw new Error('Need at least 2 groups to link');

    // All groups point to the first group's ID as the linked group
    const linkedGroupId = groupIds[0];
    await prisma.tradeGroup.updateMany({
      where: { id: { in: groupIds } },
      data: { linkedGroupId, tradeType: linkType },
    });

    return prisma.tradeGroup.findMany({ where: { id: { in: groupIds } } });
  }

  async reclassifyGroup(groupId: string, newType: TradeType) {
    return prisma.tradeGroup.update({
      where: { id: groupId },
      data: { tradeType: newType, ruleSource: 'user-reclassify' },
    });
  }

  async moveFillToGroup(fillId: string, targetGroupId: string) {
    const fill = await prisma.trade.findUnique({ where: { id: fillId } });
    if (!fill) throw new Error('Fill not found');

    const oldGroupId = fill.groupId;

    await prisma.trade.update({
      where: { id: fillId },
      data: { groupId: targetGroupId },
    });

    // Recompute both groups
    await this.recomputeGroupAggregates(targetGroupId);
    if (oldGroupId) {
      // Check if old group is now empty
      const remaining = await prisma.trade.count({ where: { groupId: oldGroupId } });
      if (remaining === 0) {
        await prisma.tradeGroup.delete({ where: { id: oldGroupId } });
      } else {
        await this.recomputeGroupAggregates(oldGroupId);
      }
    }
  }

  // ─── Recompute aggregates ───────────────────────────────────────────────

  private async recomputeGroupAggregates(groupId: string) {
    const fills = await prisma.trade.findMany({ where: { groupId } });
    if (fills.length === 0) return;

    const totalSize = fills.reduce((s, f) => s + f.size, 0);
    const totalPnl = fills.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
    const totalFees = fills.reduce((s, f) => s + (f.fees ?? 0), 0);
    const totalFunding = fills.reduce(
      (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0),
      0,
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

    const firstEntryTime = allTimes.length > 0 ? new Date(Math.min(...allTimes)) : null;
    const lastExitTime = allTimes.length > 0 ? new Date(Math.max(...allTimes)) : null;
    const holdTimeSeconds =
      firstEntryTime && lastExitTime
        ? Math.round((lastExitTime.getTime() - firstEntryTime.getTime()) / 1000)
        : null;

    const hasOpenFill = fills.some((f) => f.exitTime == null && f.exitPrice == null);

    await prisma.tradeGroup.update({
      where: { id: groupId },
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
        status: hasOpenFill ? 'open' : 'closed',
        updatedAt: new Date(),
      },
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function weightedAvg(items: { price: number; size: number }[]): number {
  const totalSize = items.reduce((s, i) => s + i.size, 0);
  if (totalSize === 0) return 0;
  return items.reduce((s, i) => s + i.price * i.size, 0) / totalSize;
}
