/**
 * grouper.ts
 *
 * Links individual fill records into logical trades (TradeGroups).
 *
 * A "trade" in the journal sense is: enter a position → hold → exit.
 * Pacifica's history returns individual fills, so we need to reconstruct
 * that lifecycle by matching opens to closes.
 *
 * --- Extensibility ---
 * The GroupingStrategy interface lets you swap in different grouping logic:
 *   - FifoGrouper (default): matches oldest open to each close (standard FIFO)
 *   - Future: LifoGrouper, TimeWindowGrouper, ManualGrouper, etc.
 *
 * To add a new strategy: implement GroupingStrategy and pass it to
 * buildGroups() or the ingestion service.
 *
 * --- Open positions ---
 * If an open fill has no matching close yet (position still open), it gets
 * a TradeGroup with status='open' and no exit data. The live monitor will
 * update these when the position eventually closes.
 *
 * --- MFE/MAE convention (for when tick data is available) ---
 * MFE (max favorable excursion) and MAE (max adverse excursion) are
 * direction-dependent:
 *   Long:  MFE = highest price reached, MAE = lowest price reached
 *   Short: MFE = lowest price reached,  MAE = highest price reached
 * These fields are left null here — they require tick-level data that
 * fill history doesn't provide. They'll be computed by a separate job.
 */

import type { TradeCreateInput } from './mapper';

// ─── Strategy interface ───────────────────────────────────────────────────────

export interface GroupingResult {
  /** Fill records with groupId now populated */
  updatedTrades: TradeCreateInput[];
  /** TradeGroup records ready to upsert */
  groups: TradeGroupCreateInput[];
}

export interface GroupingStrategy {
  readonly name: string;
  group(fills: TradeCreateInput[]): GroupingResult;
}

// ─── Prisma input type for TradeGroup ─────────────────────────────────────────

export interface TradeGroupCreateInput {
  id: string;
  walletAddress: string;
  asset: string;
  direction: string;
  status: 'open' | 'closed';
  tradeType: string;
  totalSize: number;
  averageEntryPrice: number;
  averageExitPrice: number | null;
  aggregatePnl: number | null;
  aggregateFees: number | null;
  aggregateFunding: number | null;
  entryTime: Date | null;
  exitTime: Date | null;
  holdTimeSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── FIFO Grouper ─────────────────────────────────────────────────────────────

/**
 * Standard FIFO grouper.
 *
 * For each asset+direction, maintains a queue of open fills.
 * Each close fill is matched against the oldest open fill first.
 * Handles partial closes (one close matches multiple opens).
 *
 * Open fills with no matching close → TradeGroup { status: 'open' }.
 */
export class FifoGrouper implements GroupingStrategy {
  readonly name = 'fifo';

  group(fills: TradeCreateInput[]): GroupingResult {
    // Sort ascending by entry/exit time so FIFO order is correct
    const sorted = [...fills].sort((a, b) => {
      const ta = (a.entryTime ?? a.exitTime)?.getTime() ?? 0;
      const tb = (b.entryTime ?? b.exitTime)?.getTime() ?? 0;
      return ta - tb;
    });

    // Per-asset queues of open fills waiting to be matched
    // Key: `${asset}:${direction}`
    const openQueues = new Map<string, OpenEntry[]>();

    const updatedTrades = new Map<string, TradeCreateInput>(
      sorted.map((t) => [t.id, { ...t }]),
    );
    const groups = new Map<string, TradeGroupCreateInput>();

    for (const fill of sorted) {
      const isOpen = fill.exitTime === null;
      const key = `${fill.asset}:${fill.direction}`;

      if (isOpen) {
        // Push onto the open queue for this asset+direction
        if (!openQueues.has(key)) openQueues.set(key, []);
        openQueues.get(key)!.push({
          fillId: fill.id,
          size: fill.size,
          entryPrice: fill.entryPrice,
          entryTime: fill.entryTime!,
          fees: fill.fees ?? 0,
        });
      } else {
        // Close fill — match against oldest open(s) via FIFO
        const queue = openQueues.get(key) ?? [];
        let remainingSize = fill.size;
        const matchedOpens: OpenEntry[] = [];

        while (remainingSize > 0 && queue.length > 0) {
          const oldest = queue[0];
          if (oldest.size <= remainingSize) {
            remainingSize -= oldest.size;
            matchedOpens.push({ ...oldest });
            queue.shift();
          } else {
            // Partial match — split the oldest open
            matchedOpens.push({ ...oldest, size: remainingSize });
            oldest.size -= remainingSize;
            remainingSize = 0;
          }
        }

        if (matchedOpens.length > 0) {
          const groupId = this.groupId(matchedOpens[0].fillId, fill.id);
          const entryTime = matchedOpens[0].entryTime;
          const exitTime = fill.exitTime!;
          const holdSecs = Math.round((exitTime.getTime() - entryTime.getTime()) / 1000);
          const avgEntry = weightedAvgPrice(matchedOpens);
          const totalFees = matchedOpens.reduce((s, o) => s + o.fees, 0) + (fill.fees ?? 0);

          // Tag all matched open fills with this group
          for (const open of matchedOpens) {
            const t = updatedTrades.get(open.fillId);
            if (t) {
              t.groupId = groupId;
              t.holdTimeSeconds = holdSecs;
            }
          }
          // Tag the close fill
          const closeTrade = updatedTrades.get(fill.id)!;
          closeTrade.groupId = groupId;
          closeTrade.holdTimeSeconds = holdSecs;
          closeTrade.entryTime = entryTime;

          groups.set(groupId, {
            id: groupId,
            walletAddress: fill.walletAddress,
            asset: fill.asset,
            direction: fill.direction,
            status: 'closed',
            tradeType: fill.tradeType,
            totalSize: fill.size,
            averageEntryPrice: avgEntry,
            averageExitPrice: fill.exitPrice,
            aggregatePnl: fill.pnlRealized,
            aggregateFees: totalFees,
            aggregateFunding: null, // filled in by funding ingestion
            entryTime,
            exitTime,
            holdTimeSeconds: holdSecs,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } else {
          // Close with no matching open — orphaned fill (e.g. data gap).
          // Create a standalone closed group using what we have.
          const groupId = this.groupId(fill.id, fill.id);
          const closeTrade = updatedTrades.get(fill.id)!;
          closeTrade.groupId = groupId;

          groups.set(groupId, {
            id: groupId,
            walletAddress: fill.walletAddress,
            asset: fill.asset,
            direction: fill.direction,
            status: 'closed',
            tradeType: fill.tradeType,
            totalSize: fill.size,
            averageEntryPrice: fill.entryPrice,
            averageExitPrice: fill.exitPrice,
            aggregatePnl: fill.pnlRealized,
            aggregateFees: fill.fees,
            aggregateFunding: null,
            entryTime: null,
            exitTime: fill.exitTime,
            holdTimeSeconds: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    }

    // Any fills remaining in open queues = open positions
    for (const queue of openQueues.values()) {
      for (const open of queue) {
        const groupId = this.groupId(open.fillId, 'open');
        const t = updatedTrades.get(open.fillId);
        if (t) t.groupId = groupId;

        if (!groups.has(groupId)) {
          const fill = updatedTrades.get(open.fillId)!;
          groups.set(groupId, {
            id: groupId,
            walletAddress: fill.walletAddress,
            asset: fill.asset,
            direction: fill.direction,
            status: 'open',
            tradeType: fill.tradeType,
            totalSize: open.size,
            averageEntryPrice: open.entryPrice,
            averageExitPrice: null,
            aggregatePnl: null,
            aggregateFees: open.fees,
            aggregateFunding: null,
            entryTime: open.entryTime,
            exitTime: null,
            holdTimeSeconds: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    }

    return {
      updatedTrades: Array.from(updatedTrades.values()),
      groups: Array.from(groups.values()),
    };
  }

  private groupId(openFillId: string, closeFillId: string): string {
    return `group_${openFillId}_${closeFillId}`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface OpenEntry {
  fillId: string;
  size: number;
  entryPrice: number;
  entryTime: Date;
  fees: number;
}

function weightedAvgPrice(opens: OpenEntry[]): number {
  const totalSize = opens.reduce((s, o) => s + o.size, 0);
  if (totalSize === 0) return 0;
  return opens.reduce((s, o) => s + o.entryPrice * o.size, 0) / totalSize;
}

// ─── buildGroups — the public entry point ────────────────────────────────────

/**
 * Run the grouping pass over a set of mapped fills.
 * Defaults to FifoGrouper. Pass a custom strategy to swap in different logic.
 */
export function buildGroups(
  fills: TradeCreateInput[],
  strategy: GroupingStrategy = new FifoGrouper(),
): GroupingResult {
  return strategy.group(fills);
}
