/**
 * Level 1 — Fill to Order
 *
 * Groups fills into OrderGroups by shared order identifiers from raw_data:
 *   - order_id: Pacifica assigns the same order_id to partial fills
 *   - client_order_id: user-specified ID linking TP/SL to positions
 *   - stop_parent_order_id: links TP/SL fills to their parent order
 *
 * Fills without any shared identifier become single-fill OrderGroups.
 * Every fill passes through — nothing is "stolen" from later levels.
 *
 * Answers: "How was this executed?"
 */

import type { Fill, GroupingLevel, OrderGroupData, ParsedRawData } from '../types';
import { parseRawData } from '../types';

export class FillToOrderLevel implements GroupingLevel<Fill, OrderGroupData> {
  readonly name = 'fill-to-order';

  group(fills: Fill[]): OrderGroupData[] {
    // Build union-find style map: link key → fill set
    const linkMap = new Map<string, Set<string>>(); // linkKey → fillId set
    const fillById = new Map<string, Fill>();
    const fillLinks = new Map<string, string[]>(); // fillId → linkKeys

    for (const fill of fills) {
      fillById.set(fill.id, fill);
      const raw = parseRawData(fill);
      const keys: string[] = [];

      if (raw.order_id != null) {
        keys.push(`order:${raw.order_id}`);
      }
      if (raw.client_order_id) {
        keys.push(`client:${raw.client_order_id}`);
      }
      if (raw.stop_parent_order_id != null) {
        keys.push(`stop_parent:${raw.stop_parent_order_id}`);
      }

      fillLinks.set(fill.id, keys);

      for (const key of keys) {
        if (!linkMap.has(key)) linkMap.set(key, new Set());
        linkMap.get(key)!.add(fill.id);
      }
    }

    // Merge overlapping link groups using union-find
    const parent = new Map<string, string>();
    function find(x: string): string {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    }
    function union(a: string, b: string) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    // For each link key with multiple fills, union them
    for (const [, fillIds] of linkMap) {
      const ids = Array.from(fillIds);
      for (let i = 1; i < ids.length; i++) {
        union(ids[0], ids[i]);
      }
    }

    // Also union fills that share multiple link keys
    for (const [fillId, keys] of fillLinks) {
      if (keys.length > 1) {
        // All fills across all keys for this fill should be merged
        for (const key of keys) {
          const fillIds = linkMap.get(key)!;
          for (const otherId of fillIds) {
            union(fillId, otherId);
          }
        }
      }
    }

    // Build groups from union-find
    const groups = new Map<string, Fill[]>();
    for (const fill of fills) {
      const root = find(fill.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(fill);
    }

    // Convert to OrderGroupData
    const result: OrderGroupData[] = [];
    for (const [, groupFills] of groups) {
      result.push(buildOrderGroup(groupFills));
    }

    return result;
  }
}

function buildOrderGroup(fills: Fill[]): OrderGroupData {
  // Sort chronologically
  const sorted = [...fills].sort((a, b) => {
    const ta = (a.entryTime ?? a.exitTime ?? new Date(0)).getTime();
    const tb = (b.entryTime ?? b.exitTime ?? new Date(0)).getTime();
    return ta - tb;
  });

  const asset = sorted[0].asset;
  const directions = sorted.map((f) => f.direction);
  const longCount = directions.filter((d) => d === 'long').length;
  const direction = (longCount >= directions.length / 2 ? 'long' : 'short') as 'long' | 'short';

  const totalSize = sorted.reduce((s, f) => s + f.size, 0);
  const totalPnl = sorted.reduce((s, f) => s + (f.pnlRealized ?? 0), 0);
  const totalFees = sorted.reduce((s, f) => s + (f.fees ?? 0), 0);
  const totalFunding = sorted.reduce(
    (s, f) => s + (f.fundingEarned ?? 0) - (f.fundingPaid ?? 0),
    0,
  );

  const entryFills = sorted.filter((f) => f.entryPrice > 0);
  const exitFills = sorted.filter((f) => f.exitPrice != null && f.exitPrice > 0);

  const avgEntry = weightedAvg(entryFills.map((f) => ({ price: f.entryPrice, size: f.size })));
  const avgExit = exitFills.length > 0
    ? weightedAvg(exitFills.map((f) => ({ price: f.exitPrice!, size: f.size })))
    : null;

  const allTimes = sorted
    .flatMap((f) => [f.entryTime, f.exitTime])
    .filter((t): t is Date => t != null);
  const firstEntryTime = allTimes.length > 0 ? new Date(Math.min(...allTimes.map((t) => t.getTime()))) : null;
  const lastExitTime = allTimes.length > 0 ? new Date(Math.max(...allTimes.map((t) => t.getTime()))) : null;

  // An order is "closed" if it contains any close fills (it represents an exit).
  // An order with only open fills is an entry order — still "closed" in the
  // sense that the order itself is complete, but we track position-level open/closed.
  const hasCloseFill = sorted.some((f) => {
    const raw = parseRawData(f);
    return (raw.side ?? '').startsWith('close_');
  });
  const allAreOpens = sorted.every((f) => {
    const raw = parseRawData(f);
    return (raw.side ?? '').startsWith('open_');
  });
  // Order status: 'closed' means the order is complete (all fills received)
  const status: 'open' | 'closed' = 'closed';

  const regimeAtEntry = sorted[0].regimeAtEntry ?? null;
  const sentimentAtEntry = sorted[0].sentimentAtEntry ?? null;

  return {
    id: `og_${sorted[0].id}`,
    asset,
    direction,
    fills: sorted,
    totalSize,
    averageEntryPrice: avgEntry,
    averageExitPrice: avgExit,
    pnl: totalPnl,
    fees: totalFees,
    funding: totalFunding,
    status: status as 'open' | 'closed',
    firstEntryTime,
    lastExitTime,
    tradeType: fills.length > 1 ? 'partial_fill' : 'single',
    confidence: fills.length > 1 ? 1.0 : 0.95,
    ruleSource: 'fill-to-order',
    regimeAtEntry,
    sentimentAtEntry,
  };
}

function weightedAvg(items: { price: number; size: number }[]): number {
  const totalSize = items.reduce((s, i) => s + i.size, 0);
  if (totalSize === 0) return 0;
  return items.reduce((s, i) => s + i.price * i.size, 0) / totalSize;
}
